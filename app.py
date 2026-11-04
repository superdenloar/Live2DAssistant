import os
import sys
import torch
import uuid
import config
import webbrowser
from threading import Timer
import json
from datetime import datetime
import random
import re

from flask import Flask, render_template, request, jsonify, redirect, url_for, session, abort
from functools import wraps
from datetime import timedelta
from flask_sqlalchemy import SQLAlchemy
from openai import OpenAI
import whisper
import torchaudio

# === СЛОВАРЬ КОМАНД LIVE2D ===
COMMAND_MAP = {
    "Посмотреть влево": "LOOK_LEFT",
    "Посмотреть вправо": "LOOK_RIGHT",
    "Посмотреть вверх": "LOOK_UP",
    "Посмотреть вниз": "LOOK_DOWN",
    "Слежу за курсором": "FOLLOW_CURSOR",
    "Голова влево": "HEAD_TILT_LEFT",
    "Голова вправо": "HEAD_TILT_RIGHT",
    "Закрыть левый глаз": "CLOSE_LEFT_EYE",
    "Закрыть правый глаз": "CLOSE_RIGHT_EYE",
    "Киваю головой": "NOD_HEAD",
    "Махаю головой": "SHAKE_HEAD",
}

# --- НАСТРОЙКА ПРИЛОЖЕНИЯ И БАЗЫ ДАННЫХ ---
app = Flask(__name__)
db_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'database.db')
app.config['SQLALCHEMY_DATABASE_URI'] = f'sqlite:///{db_path}'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
app.config['UPLOAD_FOLDER'] = os.path.join('static', 'Live2d_Avatars')
app.config['GIF_FOLDER'] = os.path.join('static', 'gif_avatars')
app.config['USER_AVATAR_FOLDER'] = os.path.join('static', 'user_avatars')
app.secret_key = os.environ.get('L2A_SECRET_KEY', 'live2d-assistant-mvp-secret')
app.permanent_session_lifetime = timedelta(days=30)
db = SQLAlchemy(app)

# --- Добавляем FFmpeg в PATH ---
project_dir = os.path.dirname(os.path.abspath(__file__)) 
ffmpeg_dir = os.path.join(project_dir, "ffmpeg")
if os.path.isdir(ffmpeg_dir):
    os.environ["PATH"] = ffmpeg_dir + os.pathsep + os.environ["PATH"]


def _resolve_file_path(rel_path):
    if not rel_path:
        return ""
    if os.path.isabs(rel_path) and os.path.exists(rel_path):
        return rel_path
    candidate = os.path.join(project_dir, rel_path)
    if os.path.exists(candidate):
        return candidate
    return rel_path

# --- ОПИСАНИЕ МОДЕЛЕЙ БАЗЫ ДАННЫХ ---
class User(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(80), default='Пользователь')
    description = db.Column(db.String(300), default='Описание для ассистентов...')
    avatar_url = db.Column(db.String(300), nullable=True)
    email = db.Column(db.String(200), default='admin@live2d.assistant')
    company = db.Column(db.String(200), default='Live2D Assistant')

class AppSettings(db.Model):
    """Глобальные настройки подключения к нейросети (Elysium AI, LM Studio или Custom)."""
    id = db.Column(db.Integer, primary_key=True)
    ai_provider = db.Column(db.String(50), default='elysium')  # 'elysium', 'lm_studio', 'custom'
    api_url = db.Column(db.String(300), default='https://elysiumai.garden/v1')
    api_key = db.Column(db.String(300), default='')
    model_name = db.Column(db.String(100), default='deepseek-v4-flash')
    temperature = db.Column(db.Float, default=0.7)
    enable_ai = db.Column(db.Boolean, default=True)

class Assistant(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(80), nullable=False)
    description = db.Column(db.String(300))
    photo_url = db.Column(db.String(200), default='Img/default_avatar.png')
    system_prompt = db.Column(db.Text, nullable=False)
    model_name = db.Column(db.String(100), nullable=True)  # Переопределение модели для конкретного ассистента
    live2d_model_path = db.Column(db.String(300))
    tts_model_path = db.Column(db.String(300))
    tts_speaker = db.Column(db.String(80), default='kseniya')
    scale = db.Column(db.Float, default=2.4)
    pos_x = db.Column(db.Integer, default=0)
    pos_y = db.Column(db.Integer, default=50)
    memory_depth = db.Column(db.Integer, default=10)
    mouth_min_open = db.Column(db.Float, default=0.05)
    mouth_max_open = db.Column(db.Float, default=0.8)
    mouth_jitter_strength = db.Column(db.Float, default=0.05)
    mouth_jitter_speed = db.Column(db.Float, default=50.0)
    boredom_enabled = db.Column(db.Boolean, default=False)
    boredom_min_time = db.Column(db.Integer, default=30)
    boredom_max_time = db.Column(db.Integer, default=120)
    patting_enabled = db.Column(db.Boolean, default=False)
    patting_tilt_angle = db.Column(db.Float, default=15.0)
    patting_eye_close = db.Column(db.Float, default=0.8)
    patting_follow_strength = db.Column(db.Float, default=0.1)
    boredom_use_llm = db.Column(db.Boolean, default=False, nullable=False)
    widget_mode = db.Column(db.String(20), default='popup', nullable=False)  # 'popup' (классика) | 'card' | 'novel'
    widget_layout = db.Column(db.Text, nullable=True)  # JSON: размеры и расположение виджета для каждого режима
    greeting_phrase = db.Column(db.String(500), default='Привет! Чем могу помочь? 😊')
    widget_primary_color = db.Column(db.String(30), default='#667eea')
    widget_bg_color = db.Column(db.String(30), default='rgba(15,15,30,0.92)')
    widget_text_color = db.Column(db.String(30), default='#e0e0f0')
    widget_user_bubble_color = db.Column(db.String(30), default='#667eea')
    # Тип аватара: 'live2d' | 'gif' | 'text' (3D/видео — в разработке)
    avatar_type = db.Column(db.String(20), default='live2d')
    # GIF / PNG-тубер: 'frames' — кадр выбирается по громкости речи (как example.py),
    #                  'swap'   — две картинки «молчит / говорит»
    gif_mode = db.Column(db.String(20), default='frames')
    gif_source_url = db.Column(db.String(300), nullable=True)   # исходный GIF (кадры по громкости)
    gif_frames = db.Column(db.Text, nullable=True)               # JSON-список кадров
    gif_idle_url = db.Column(db.String(300), nullable=True)     # картинка «молчит»
    gif_talk_url = db.Column(db.String(300), nullable=True)     # картинка/GIF «говорит»
    gif_scale = db.Column(db.Float, default=1.0)
    gif_offset_y = db.Column(db.Integer, default=0)
    gif_noise_floor = db.Column(db.Float, default=0.008)
    gif_smoothing = db.Column(db.Float, default=0.35)
    gif_breathing = db.Column(db.Boolean, default=True)
    model3d = db.Column(db.Text, nullable=True)        # JSON: файл .glb и посадка 3D-модели
    gif_disabled = db.Column(db.Text, nullable=True)   # JSON: номера отключённых кадров
    gif_chroma = db.Column(db.Text, nullable=True)     # JSON: настройки хромакея и версия обработанных кадров
    boredom_phrases = db.relationship('BoredomPhrase', backref='assistant', lazy=True, cascade="all, delete-orphan")
    chats = db.relationship('Chat', backref='assistant', lazy=True, cascade="all, delete-orphan")

class Chat(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(120), nullable=False)
    assistant_id = db.Column(db.Integer, db.ForeignKey('assistant.id'), nullable=False)
    # 'ai' — отвечает ассистент, 'waiting' — клиент ждёт оператора, 'operator' — отвечает оператор
    status = db.Column(db.String(20), default='ai')
    source = db.Column(db.String(20), default='studio')  # 'studio' | 'widget'
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    operator_seen_id = db.Column(db.Integer, default=0)
    messages = db.relationship('Message', backref='chat', lazy=True, cascade="all, delete-orphan")

class Message(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    chat_id = db.Column(db.Integer, db.ForeignKey('chat.id'), nullable=False)
    role = db.Column(db.String(10), nullable=False)
    content = db.Column(db.Text, nullable=False)
    timestamp = db.Column(db.DateTime, default=datetime.utcnow)
    audio_url = db.Column(db.String(200), nullable=True)

class BoredomPhrase(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    text = db.Column(db.String(300), nullable=False)
    assistant_id = db.Column(db.Integer, db.ForeignKey('assistant.id'), nullable=False)

# --- СЛОВАРЬ ГОЛОСОВ ---
MODEL_SPEAKERS = {
    'ru_v3': ['aidar', 'baya', 'kseniya', 'xenia', 'eugene'],
    'v4_ru': ['aidar', 'baya', 'kseniya', 'xenia', 'eugene'],
    'model': ['aidar', 'baya', 'kseniya', 'xenia', 'eugene']
}

# --- Инициализация нейросетей ---
device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
whisper_model = None
active_silero_model = None
active_assistant_id = None


# =======================================================
#      УПРАВЛЕНИЕ НАСТРОЙКАМИ API И ELYSIUM AI
# =======================================================

def get_ai_settings():
    """Получает сохраненные настройки API или инициализирует их из config.py."""
    settings = AppSettings.query.first()
    if not settings:
        default_provider = getattr(config, 'AI_PROVIDER', 'elysium')
        default_url = getattr(config, 'ELYSIUM_API_URL', 'https://elysiumai.garden/v1')
        default_key = getattr(config, 'ELYSIUM_API_KEY', '') or os.environ.get('ELYSIUM_API_KEY', '')
        default_model = getattr(config, 'ELYSIUM_MODEL', 'deepseek-v4-flash')
        default_temp = getattr(config, 'AI_TEMPERATURE', 0.7)
        default_enable = getattr(config, 'ENABLE_AI', getattr(config, 'ENABLE_LM_STUDIO', True))

        settings = AppSettings(
            ai_provider=default_provider,
            api_url=default_url,
            api_key=default_key,
            model_name=default_model,
            temperature=default_temp,
            enable_ai=default_enable
        )
        db.session.add(settings)
        db.session.commit()
    return settings


def get_effective_api_key(settings=None):
    """Возвращает рабочий API ключ (из БД, из config.py или из переменной окружения)."""
    if settings is None:
        settings = get_ai_settings()
    return (settings.api_key or '').strip() or getattr(config, 'ELYSIUM_API_KEY', '').strip() or os.environ.get('ELYSIUM_API_KEY', '').strip() or ''


def get_ai_client(settings=None):
    """Создает клиент OpenAI с актуальными параметрами подключения."""
    if settings is None:
        settings = get_ai_settings()

    provider = settings.ai_provider or 'elysium'
    api_key = get_effective_api_key(settings)

    if provider == 'lm_studio':
        base_url = (settings.api_url or getattr(config, 'LM_STUDIO_URL', 'http://127.0.0.1:1234/v1')).strip()
        api_key = api_key or "not-needed"
    else:
        base_url = (settings.api_url or getattr(config, 'ELYSIUM_API_URL', 'https://elysiumai.garden/v1')).strip()
        if not api_key:
            api_key = "missing-key"

    return OpenAI(base_url=base_url, api_key=api_key)


# Создаем объект-обертку для обратной совместимости
class DynamicClientProxy:
    def __getattr__(self, name):
        real_client = get_ai_client()
        return getattr(real_client, name)

client = DynamicClientProxy()


def clean_ai_response(raw_text):
    """
    Очищает ответ модели от тегов размышлений <think>...</think>,
    которые генерируют модели DeepSeek (DeepSeek-V4, R1 и др.).
    """
    if not raw_text:
        return ""
    # Удаляем парные теги <think>...</think>
    cleaned = re.sub(r'<think>[\s\S]*?</think>', '', raw_text, flags=re.DOTALL).strip()
    if not cleaned and raw_text:
        # Если тег не был закрыт или ответ целиком внутри think
        cleaned = re.sub(r'</?think>', '', raw_text).strip()
    return cleaned


def prepare_text_for_tts(text):
    """
    Очищает текст перед отправкой в Silero TTS:
    удаляет <think>, команды Live2D 【...】, markdown-символы, эмодзи и спецсимволы,
    которые вызывают сбои или нежелательное озвучивание знаков.
    """
    if not text:
        return ""
    s = re.sub(r'<think>[\s\S]*?</think>', '', text, flags=re.DOTALL)
    s = re.sub(r'【.*?】', '', s)
    s = re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', s)
    s = re.sub(r'[`*_#~>|]', '', s)
    s = re.sub(r'[\U00010000-\U0010ffff]', '', s)
    s = re.sub(r'[\u2600-\u27bf]', '', s)
    s = re.sub(r'[\ud83c\ud000-\ud83e\uddff]', '', s)
    s = re.sub(r'\s+', ' ', s).strip()
    return s


def load_default_system_prompt():
    """Считывает системный промпт по умолчанию из system_prompt.txt."""
    prompt_file = getattr(config, 'SYSTEM_PROMPT_FILE', 'system_prompt.txt')
    file_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), prompt_file)
    if os.path.exists(file_path):
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                content = f.read().strip()
                if content:
                    return content
        except Exception as e:
            print(f"Ошибка чтения {file_path}: {e}")
    return "Ты милый аниме голосовой ассистент с Live2D телом."


def build_conversation_messages(assistant, chat_id, raw_user_input="", is_patting_reaction=False, extra_context=None):
    """
    Формирует полный контекст сообщений для отправки в нейросеть.
    Включает системный промпт ассистента, профиль пользователя,
    правила Live2D команд и историю последних реплик.
    """
    user_profile = User.query.first()
    history_from_db = Message.query.filter_by(chat_id=chat_id).order_by(Message.timestamp.desc()).limit(assistant.memory_depth).all()
    history_from_db.reverse()

    user_info = ""
    if user_profile and (user_profile.name or user_profile.description):
        user_info = (
            f"\n\n[Информация о собеседнике]\n"
            f"Имя: {user_profile.name}\n"
            f"Описание: {user_profile.description}"
        )

    commands_guide = ""
    if "【" not in (assistant.system_prompt or ""):
        commands_guide = (
            "\n\n[Управление движениями Live2D]\n"
            "Ты можешь сопровождать свои реплики командами движений в скобках 【Команда】: "
            "【Киваю головой】, 【Махаю головой】, 【Посмотреть влево】, 【Посмотреть вправо】, "
            "【Посмотреть вверх】, 【Посмотреть вниз】, 【Слежу за курсором】, 【Голова влево】, "
            "【Голова вправо】, 【Закрыть левый глаз】, 【Закрыть правый глаз】.\n"
            "Используй их органично. Текст команд будет исполнен анимацией модели и не будет озвучен."
        )

    voice_guide = (
        "\n\n[Озвучка TTS]\n"
        "Твой ответ будет озвучен синтезом речи. Не используй смайлики/эмодзи и сложную markdown-разметку."
    )

    full_system_prompt = (assistant.system_prompt or "") + user_info + commands_guide + voice_guide

    conversation_history = [{"role": "system", "content": full_system_prompt}]

    for msg in history_from_db:
        if msg.role == 'system':
            continue
        if msg.role == 'operator':
            conversation_history.append({"role": "assistant", "content": f"[Ответ живого оператора поддержки] {msg.content}"})
            continue
        clean_msg = clean_ai_response(msg.content) if msg.role == 'assistant' else msg.content
        if clean_msg:
            conversation_history.append({"role": msg.role, "content": clean_msg})

    content_for_llm = ""
    if is_patting_reaction:
        content_for_llm += "*(Ты чувствуешь, что тебя долго и нежно гладили. Можешь отреагировать на это.)*\n\n"

    if raw_user_input:
        content_for_llm += raw_user_input

    if extra_context:
        content_for_llm += "\n\n" + extra_context

    if content_for_llm:
        conversation_history.append({"role": "user", "content": content_for_llm})

    return conversation_history, content_for_llm


def call_llm_completion(messages, assistant=None, temperature=None):
    """
    Отправляет запрос к настроенной модели Elysium AI (или выбранному провайдеру).
    Возвращает строку с ответом или понятное сообщение об ошибке.
    """
    settings = get_ai_settings()
    if not settings.enable_ai:
        return "Нейросеть отключена в настройках приложения."

    api_key = get_effective_api_key(settings)
    provider = settings.ai_provider or 'elysium'

    if provider != 'lm_studio' and not api_key:
        return "⚠️ Внимание: API ключ не настроен. Пожалуйста, откройте вкладку «Нейросеть (API)» в меню слева и вставьте ваш ключ от Elysium AI."

    model_name = getattr(assistant, 'model_name', None) if assistant else None
    if not model_name or not model_name.strip():
        model_name = settings.model_name or getattr(config, 'ELYSIUM_MODEL', 'deepseek-v4-flash')

    temp = temperature if temperature is not None else (settings.temperature or 0.7)
    active_client = get_ai_client(settings)

    try:
        completion = active_client.chat.completions.create(
            model=model_name,
            messages=messages,
            temperature=temp,
        )
        if not completion.choices:
            return "Не удалось получить ответ от нейросети (пустой список ответов)."

        choice = completion.choices[0]
        content = choice.message.content
        if not content and hasattr(choice.message, 'reasoning_content') and choice.message.reasoning_content:
            content = choice.message.reasoning_content
        return (content or "").strip()
    except Exception as e:
        err_str = str(e)
        print(f"!!! ОШИБКА API ({provider} - {model_name}): {err_str}")
        if "401" in err_str or "unauthorized" in err_str.lower():
            return "⚠️ Ошибка авторизации (401): неверный API-ключ Elysium AI. Проверьте ключ во вкладке «Нейросеть (API)»."
        elif "402" in err_str or "insufficient" in err_str.lower() or "balance" in err_str.lower():
            return "⚠️ Ошибка баланса: на вашем счете Elysium AI недостаточно средств."
        elif "404" in err_str or "not found" in err_str.lower():
            return f"⚠️ Ошибка: модель '{model_name}' не найдена в Elysium AI. Проверьте название модели в настройках."
        elif "connection" in err_str.lower() or "connect" in err_str.lower():
            return f"⚠️ Ошибка соединения с сервером API ({settings.api_url}). Проверьте подключение к интернету."
        else:
            return f"⚠️ Ошибка вызова нейросети: {err_str}"


def _with_cors(response):
    response.headers['Access-Control-Allow-Origin'] = '*'
    response.headers['Access-Control-Allow-Headers'] = 'Content-Type'
    response.headers['Access-Control-Allow-Methods'] = 'POST, GET, OPTIONS'
    return response


@app.after_request
def apply_cors(response):
    """Автоматический CORS для всех /api/ и /static/ маршрутов."""
    if request.path.startswith('/api/') or request.path.startswith('/static/'):
        response.headers['Access-Control-Allow-Origin'] = '*'
        response.headers['Access-Control-Allow-Headers'] = 'Content-Type'
        response.headers['Access-Control-Allow-Methods'] = 'POST, GET, OPTIONS'
    return response


def _resolve_bridge_chat(chat_id=None, assistant_id=None, external_session_id=None):
    """
    Возвращает чат для bridge-запроса.
    Приоритет: chat_id -> (assistant_id + external_session_id) -> активный ассистент -> первый ассистент.
    """
    if chat_id:
        return db.get_or_404(Chat, chat_id)

    resolved_assistant = None
    if assistant_id:
        resolved_assistant = db.get_or_404(Assistant, assistant_id)
    elif active_assistant_id:
        resolved_assistant = db.session.get(Assistant, active_assistant_id)
    if not resolved_assistant:
        resolved_assistant = Assistant.query.order_by(Assistant.id.asc()).first()

    if not resolved_assistant:
        raise ValueError('No assistants configured. Create assistant first.')

    if external_session_id:
        chat_name = f"Bridge session {external_session_id}"
        existing_chat = Chat.query.filter_by(name=chat_name, assistant_id=resolved_assistant.id).first()
        if existing_chat:
            return existing_chat
    else:
        chat_name = f"Bridge {resolved_assistant.name}"
        existing_chat = Chat.query.filter_by(name=chat_name, assistant_id=resolved_assistant.id).first()
        if existing_chat:
            return existing_chat

    new_chat = Chat(name=chat_name, assistant_id=resolved_assistant.id, source='widget')
    db.session.add(new_chat)
    db.session.commit()
    return new_chat


def admin_required(view):
    """Простая MVP-защита: страницы кабинета доступны только после «Войти как администратор»."""
    @wraps(view)
    def wrapper(*args, **kwargs):
        if not session.get('is_admin'):
            if request.path.startswith('/api/'):
                return jsonify({'error': 'auth required'}), 401
            return redirect(url_for('landing', login=1))
        return view(*args, **kwargs)
    return wrapper


@app.route('/studio')
@admin_required
def index():
    user_profile = User.query.first()
    assistants = Assistant.query.all()
    chats = Chat.query.order_by(Chat.id.desc()).all()
    api_settings = get_ai_settings()
    
    active_assistant = db.session.get(Assistant, active_assistant_id) if active_assistant_id else None
    if not active_assistant and chats:
        active_assistant = chats[0].assistant
    elif not active_assistant and assistants:
        active_assistant = assistants[0]

    selected_chat = None
    want_assistant = request.args.get('assistant', type=int)
    want_chat = request.args.get('chat', type=int)
    if want_chat:
        selected_chat = db.session.get(Chat, want_chat)
    elif want_assistant and db.session.get(Assistant, want_assistant):
        selected_chat = Chat.query.filter(Chat.assistant_id == want_assistant, ~Chat.name.like('Bridge%')).order_by(Chat.id.desc()).first()
        if not selected_chat:
            a = db.session.get(Assistant, want_assistant)
            selected_chat = Chat(name=f"Тест: {a.name}", assistant_id=a.id, source='studio')
            db.session.add(selected_chat)
            db.session.commit()
            chats = Chat.query.order_by(Chat.id.desc()).all()
    if selected_chat:
        active_assistant = selected_chat.assistant
        chats = [selected_chat] + [c for c in chats if c.id != selected_chat.id]

    frontend_config = {
        "model_path": active_assistant.live2d_model_path if active_assistant else "",
        "scale": active_assistant.scale if active_assistant else 2.4, 
        "posX": active_assistant.pos_x if active_assistant else 0, 
        "posY": active_assistant.pos_y if active_assistant else 50,
        "active_chat_id": chats[0].id if chats else None,
        "active_assistant_id": active_assistant.id if active_assistant else None,
        "patting_enabled": active_assistant.patting_enabled if active_assistant else False,
        "patting_tilt_angle": active_assistant.patting_tilt_angle if active_assistant else 15.0,
        "patting_eye_close": active_assistant.patting_eye_close if active_assistant else 0.8,
        "patting_follow_strength": active_assistant.patting_follow_strength if active_assistant else 0.1,
        "boredom_enabled": active_assistant.boredom_enabled if active_assistant else False,
        "boredom_min_time": active_assistant.boredom_min_time if active_assistant else 30,
        "boredom_max_time": active_assistant.boredom_max_time if active_assistant else 120,
        **(avatar_payload(active_assistant) if active_assistant else {'avatar_type': 'live2d'})
    }
    
    return render_template(
        'index.html', 
        config_data=frontend_config, 
        user=user_profile, 
        assistants=assistants, 
        chats=chats,
        api_settings=api_settings
    )


@app.route('/chat/<int:chat_id>/load')
def load_chat(chat_id):
    global active_silero_model, active_assistant_id
    
    print(f"\n[DEBUG] Поступил запрос на загрузку чата с ID: {chat_id}")
    chat = db.get_or_404(Chat, chat_id)
    active_assistant_id = chat.assistant_id
    assistant = chat.assistant
    
    messages_from_db = Message.query.filter_by(chat_id=chat_id).order_by(Message.timestamp).all()
    messages = [{"id": msg.id, "role": msg.role, "content": msg.content, "audio_url": msg.audio_url} for msg in messages_from_db]
    
    print(f"[DEBUG] Найдено и обработано сообщений в чате: {len(messages)}")

    try:
        tts_file = _resolve_file_path(assistant.tts_model_path) if assistant else ""
        if tts_file and os.path.exists(tts_file):
            active_silero_model = torch.package.PackageImporter(tts_file).load_pickle("tts_models", "model")
            active_silero_model.to(device)
    except Exception as e:
        print(f"!!! ОШИБКА при загрузке модели Silero для чата {chat_id}: {e}")
        active_silero_model = None
        
    data_to_send = {
        "messages": messages,
        "assistant": { 
            "id": assistant.id, 
            "name": assistant.name, 
            "live2d_model_path": assistant.live2d_model_path, 
            "scale": assistant.scale, 
            "posX": assistant.pos_x, 
            "posY": assistant.pos_y, 
            "patting_enabled": assistant.patting_enabled, 
            "patting_tilt_angle": assistant.patting_tilt_angle, 
            "patting_eye_close": assistant.patting_eye_close, 
            "patting_follow_strength": assistant.patting_follow_strength, 
            "boredom_enabled": assistant.boredom_enabled, 
            "boredom_min_time": assistant.boredom_min_time, 
            "boredom_max_time": assistant.boredom_max_time,
            "boredom_use_llm": assistant.boredom_use_llm,
            **avatar_payload(assistant)
        }
    }
    return jsonify(data_to_send)


@app.route('/chat/create', methods=['POST'])
def create_chat():
    name = request.form.get('chat_name')
    assistant_id = request.form.get('assistant_id', type=int)
    if name and assistant_id:
        new_chat = Chat(name=name, assistant_id=assistant_id, source='studio')
        db.session.add(new_chat)
        db.session.commit()
    return redirect(request.form.get('next') or url_for('index'))


@app.route('/chat/<int:chat_id>/delete', methods=['POST'])
def delete_chat(chat_id):
    chat_to_delete = db.get_or_404(Chat, chat_id)
    db.session.delete(chat_to_delete)
    db.session.commit()
    if request.headers.get('Accept', '').startswith('application/json') or request.is_json:
        return jsonify({'success': True})
    return redirect(request.form.get('next') or url_for('index'))


@app.route('/chat/<int:chat_id>/settings_data')
def chat_settings_data(chat_id):
    chat = db.get_or_404(Chat, chat_id)
    assistants = Assistant.query.all()
    return jsonify({
        'chat_name': chat.name,
        'current_assistant_id': chat.assistant_id,
        'assistants': [{'id': a.id, 'name': a.name} for a in assistants]
    })


@app.route('/chat/<int:chat_id>/update_settings', methods=['POST'])
def update_chat_settings(chat_id):
    chat = db.get_or_404(Chat, chat_id)
    chat_name = request.form.get('chat_name')
    assistant_id = request.form.get('assistant_id', type=int)
    if chat_name:
        chat.name = chat_name
    if assistant_id:
        chat.assistant_id = assistant_id
    db.session.commit()
    return redirect(url_for('index'))


@app.route('/profile/update', methods=['POST'])
def update_profile():
    try:
        user_profile = User.query.first()
        if not user_profile:
            user_profile = User()
            db.session.add(user_profile)

        user_profile.name = request.form.get('name')
        user_profile.description = request.form.get('description')
        db.session.commit()
        return jsonify({'success': True, 'message': 'Профиль успешно сохранен.'})
    except Exception as e:
        db.session.rollback()
        print(f"!!! ОШИБКА обновления профиля: {e}")
        return jsonify({'success': False, 'message': 'Не удалось сохранить профиль.'}), 500


# --- ОСНОВНОЙ ОБРАБОТЧИК ЧАТА ---

@app.route('/chat', methods=['POST'])
def chat():
    chat_id = request.form.get('chat_id', type=int)
    if not chat_id:
        return jsonify({"error": "Chat ID is required"}), 400

    chat_session = db.get_or_404(Chat, chat_id)
    assistant = chat_session.assistant
    user_message_id, ai_message_id = None, None
    raw_user_input = ""
    raw_ai_response = ""
    final_live2d_commands = []
    audio_url = ""
    
    try:
        # 1. Получаем ввод пользователя (голос или текст)
        user_message_audio_url = None

        if 'audio_blob' in request.files:
            audio_file = request.files['audio_blob']
            filename = f"{uuid.uuid4()}.webm" 
            temp_path = os.path.join("temp_audio", filename)
            audio_file.save(temp_path)
            if whisper_model is not None:
                result = whisper.transcribe(whisper_model, temp_path, fp16=False)
                raw_user_input = result['text'].strip() if result.get('text') else ""
            user_message_audio_url = temp_path
        elif 'text' in request.form:
            raw_user_input = request.form.get('text', '').strip()

        # 2. Извлекаем команды из сообщения пользователя
        user_live2d_commands = []
        user_command_matches = re.findall(r'【(.*?)】', raw_user_input)
        if user_command_matches:
            for command_text in user_command_matches:
                system_command = COMMAND_MAP.get(command_text.strip())
                if system_command:
                    user_live2d_commands.append(system_command)
        
        # 3. Формируем контекст с системным промптом, историей и инструкциями
        is_patting = (request.form.get('patting_reaction') == 'true')
        conversation_history, content_for_llm = build_conversation_messages(
            assistant=assistant,
            chat_id=chat_id,
            raw_user_input=raw_user_input,
            is_patting_reaction=is_patting
        )
        
        # 4. Генерация ответа через настроенный API (Elysium AI / deepseek-v4-flash)
        if content_for_llm:
            generated = call_llm_completion(conversation_history, assistant=assistant)
            raw_ai_response = clean_ai_response(generated)

        # 5. Извлекаем команды Live2D из ответа нейросети
        ai_live2d_commands = []
        ai_command_matches = re.findall(r'【(.*?)】', raw_ai_response)
        if ai_command_matches:
            for command_text in ai_command_matches:
                system_command = COMMAND_MAP.get(command_text.strip())
                if system_command:
                    ai_live2d_commands.append(system_command)
        
        final_live2d_commands = ai_live2d_commands if ai_live2d_commands else user_live2d_commands

        # Сохраняем реальные сообщения в БД
        if raw_user_input:
            user_message = Message(chat_id=chat_id, role='user', content=raw_user_input, audio_url=user_message_audio_url)
            db.session.add(user_message)
        
        if raw_ai_response:
            ai_message = Message(chat_id=chat_id, role='assistant', content=raw_ai_response)
            db.session.add(ai_message)
        
        if raw_user_input or raw_ai_response:
            db.session.commit()
            if 'user_message' in locals() and user_message:
                user_message_id = user_message.id
            if 'ai_message' in locals() and ai_message:
                ai_message_id = ai_message.id

        # 6. Синтез речи Silero TTS (с предварительной очисткой от тегов и эмодзи)
        text_for_tts = prepare_text_for_tts(raw_ai_response)
        if active_silero_model and text_for_tts:
            try:
                output_wav_path = "static/response.wav"
                audio_tensor = active_silero_model.apply_tts(
                    text=text_for_tts, 
                    speaker=assistant.tts_speaker, 
                    sample_rate=config.SILERO_SAMPLE_RATE
                )
                torchaudio.save(output_wav_path, audio_tensor.unsqueeze(0).cpu(), config.SILERO_SAMPLE_RATE)
                audio_url = f'/{output_wav_path}?v={uuid.uuid4()}'
            except Exception as tts_err:
                print(f"!!! ПРЕДУПРЕЖДЕНИЕ: Ошибка озвучки Silero: {tts_err}")
                audio_url = ""
            
    except Exception as e:
        db.session.rollback()
        print(f"!!! КРИТИЧЕСКАЯ ОШИБКА в /chat: {e}")
        raw_ai_response = f"Произошла ошибка обработки: {e}"
        final_live2d_commands = []
        
    return jsonify({
        'user_text': raw_user_input, 
        'ai_text': raw_ai_response,
        'audio_url': audio_url,
        'user_message_id': user_message_id,
        'ai_message_id': ai_message_id,
        'live2d_commands': final_live2d_commands
    })


# --- API ДЛЯ ВИДЖЕТА И НАСТРОЕК ---

@app.route('/api/settings', methods=['GET'])
def get_api_settings_route():
    settings = get_ai_settings()
    return jsonify({
        'provider': settings.ai_provider,
        'api_url': settings.api_url,
        'api_key': settings.api_key,
        'model_name': settings.model_name,
        'temperature': settings.temperature,
        'enable_ai': settings.enable_ai
    })


@app.route('/api/settings', methods=['POST'])
def update_api_settings_route():
    try:
        data = request.get_json(silent=True) or request.form.to_dict()
        settings = get_ai_settings()

        if 'provider' in data and data['provider']:
            settings.ai_provider = data['provider'].strip()
        if 'api_url' in data and data['api_url']:
            settings.api_url = data['api_url'].strip()
        if 'api_key' in data:
            settings.api_key = data['api_key'].strip()
        if 'model_name' in data and data['model_name']:
            settings.model_name = data['model_name'].strip()
        if 'temperature' in data:
            try:
                settings.temperature = float(data['temperature'])
            except (ValueError, TypeError):
                pass
        if 'enable_ai' in data:
            val = data['enable_ai']
            settings.enable_ai = (val is True or val == 'true' or val == '1' or val == 1)

        db.session.commit()
        return jsonify({'success': True, 'message': 'Настройки API успешно сохранены.'})
    except Exception as e:
        db.session.rollback()
        print(f"Ошибка сохранения настроек API: {e}")
        return jsonify({'success': False, 'message': str(e)}), 500


@app.route('/api/settings/test', methods=['POST'])
def test_api_connection_route():
    data = request.get_json(silent=True) or {}
    provider = data.get('provider') or 'elysium'
    api_url = (data.get('api_url') or 'https://elysiumai.garden/v1').strip()
    api_key = (data.get('api_key') or '').strip()
    model_name = (data.get('model_name') or 'deepseek-v4-flash').strip()

    if provider != 'lm_studio' and not api_key:
        return jsonify({'success': False, 'message': 'API ключ не указан!'}), 400

    effective_key = api_key if api_key else "not-needed"
    try:
        test_client = OpenAI(base_url=api_url, api_key=effective_key, timeout=15.0)
        completion = test_client.chat.completions.create(
            model=model_name,
            messages=[
                {"role": "system", "content": "Ты голосовой ассистент."},
                {"role": "user", "content": "Скажи одним словом 'Работает'"}
            ],
            max_tokens=30,
            temperature=0.5
        )
        content = ""
        if completion.choices:
            content = completion.choices[0].message.content or ""
        clean_text = clean_ai_response(content).strip()
        return jsonify({
            'success': True,
            'message': f'Связь установлена! Модель «{model_name}» ответила: «{clean_text or "Работает"}»',
            'model': model_name
        })
    except Exception as e:
        err_str = str(e)
        return jsonify({
            'success': False,
            'message': f'Ошибка подключения: {err_str}'
        }), 400


@app.route('/assistant/default_prompt', methods=['GET'])
def get_default_prompt():
    prompt = load_default_system_prompt()
    return jsonify({'prompt': prompt})


@app.route('/api/assistants')
def api_list_assistants():
    """Возвращает JSON-список всех ассистентов."""
    assistants = Assistant.query.all()
    result = []
    for a in assistants:
        result.append({
            'id': a.id,
            'name': a.name,
            'description': a.description,
            'photo_url': f'/static/{a.photo_url}',
        })
    return jsonify(result)


@app.route('/api/widget/config/<int:assistant_id>')
def api_widget_config(assistant_id):
    """Возвращает полную конфигурацию ассистента для виджета."""
    assistant = db.get_or_404(Assistant, assistant_id)
    return jsonify({
        'id': assistant.id,
        'name': assistant.name,
        'live2d_model_path': assistant.live2d_model_path,
        'scale': assistant.scale,
        'posX': assistant.pos_x,
        'posY': assistant.pos_y,
        'photo_url': f'/static/{assistant.photo_url}',
        'patting_enabled': assistant.patting_enabled,
        'patting_tilt_angle': assistant.patting_tilt_angle,
        'patting_eye_close': assistant.patting_eye_close,
        'patting_follow_strength': assistant.patting_follow_strength,
        'boredom_enabled': assistant.boredom_enabled,
        'boredom_min_time': assistant.boredom_min_time,
        'boredom_max_time': assistant.boredom_max_time,
        'boredom_use_llm': assistant.boredom_use_llm,
        'mouth_min_open': assistant.mouth_min_open,
        'mouth_max_open': assistant.mouth_max_open,
        'mouth_jitter_strength': assistant.mouth_jitter_strength,
        'mouth_jitter_speed': assistant.mouth_jitter_speed,
        'widget_mode': assistant.widget_mode or 'popup',
        'widget_layout': parse_layout(assistant.widget_layout),
        'greeting_phrase': assistant.greeting_phrase or 'Привет! Чем могу помочь? 😊',
        'widget_primary_color': assistant.widget_primary_color or '#667eea',
        'widget_bg_color': assistant.widget_bg_color or 'rgba(15,15,30,0.92)',
        'widget_text_color': assistant.widget_text_color or '#e0e0f0',
        'widget_user_bubble_color': assistant.widget_user_bubble_color or '#667eea',
        **avatar_payload(assistant),
    })


@app.route('/api/embed/<int:assistant_id>')
def api_embed_page(assistant_id):
    """Страница-справка для разработчиков: как встроить виджет на свой сайт."""
    assistant = db.get_or_404(Assistant, assistant_id)
    server_url = request.host_url.rstrip('/')
    return f"""<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Встраивание ассистента: {assistant.name}</title>
    <style>
        * {{ margin:0; padding:0; box-sizing:border-box; }}
        body {{ font-family:'Inter',system-ui,sans-serif; background:#0f0f1e; color:#e0e0f0; padding:40px; line-height:1.6; }}
        .container {{ max-width:800px; margin:0 auto; }}
        h1 {{ font-size:24px; margin-bottom:8px; background:linear-gradient(135deg,#667eea,#764ba2); -webkit-background-clip:text; -webkit-text-fill-color:transparent; }}
        h2 {{ font-size:18px; margin:32px 0 12px; color:#a8b4ff; }}
        p {{ color:#aaa; margin-bottom:16px; }}
        .card {{ background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08); border-radius:12px; padding:20px; margin-bottom:20px; }}
        .assistant-info {{ display:flex; align-items:center; gap:16px; margin-bottom:24px; }}
        .assistant-info img {{ width:64px; height:64px; border-radius:50%; border:2px solid #667eea; }}
        .assistant-info .name {{ font-size:20px; font-weight:600; }}
        .assistant-info .desc {{ color:#888; font-size:14px; }}
        .assistant-info .mode {{ display:inline-block; background:rgba(102,126,234,0.2); color:#a8b4ff; padding:2px 10px; border-radius:8px; font-size:12px; margin-top:4px; }}
        pre {{ background:#1a1a2e; border:1px solid rgba(255,255,255,0.1); border-radius:8px; padding:16px; overflow-x:auto; font-size:13px; color:#66eea0; position:relative; }}
        .copy-btn {{ position:absolute; top:8px; right:8px; background:#667eea; border:none; color:#fff; padding:4px 12px; border-radius:6px; cursor:pointer; font-size:12px; }}
        .copy-btn:hover {{ background:#764ba2; }}
        code {{ font-family:'Fira Code','Consolas',monospace; }}
        a {{ color:#667eea; text-decoration:none; }} a:hover {{ text-decoration:underline; }}
        .id-badge {{ display:inline-block; background:rgba(102,126,234,0.15); border:1px solid rgba(102,126,234,0.3); padding:2px 8px; border-radius:6px; font-family:monospace; color:#a8b4ff; }}
    </style>
</head>
<body>
    <div class="container">
        <h1>🔌 Встраивание Live2D ассистента</h1>
        <p>Инструкция для разработчиков — как добавить этого ассистента на любой сайт.</p>

        <div class="card assistant-info">
            <img src="/static/{assistant.photo_url}" alt="{assistant.name}">
            <div>
                <div class="name">{assistant.name}</div>
                <div class="desc">{assistant.description or 'Нет описания'}</div>
                <div class="mode">Режим: {assistant.widget_mode or 'novel'}</div>
            </div>
        </div>

        <h2>Быстрый старт</h2>
        <p>Добавьте этот код перед <code>&lt;/body&gt;</code> на вашем сайте:</p>
        <pre><code>&lt;script src="{server_url}/static/widget.js"
        data-server="{server_url}"
        data-assistant-id="{assistant.id}"&gt;&lt;/script&gt;</code><button class="copy-btn" onclick="navigator.clipboard.writeText(this.previousElementSibling.textContent)">Копировать</button></pre>

        <h2>API эндпоинты</h2>
        <div class="card">
            <p><strong>Конфигурация ассистента:</strong><br>
            <code>GET <a href="{server_url}/api/widget/config/{assistant.id}">{server_url}/api/widget/config/{assistant.id}</a></code></p>
            <p><strong>Список ассистентов:</strong><br>
            <code>GET <a href="{server_url}/api/assistants">{server_url}/api/assistants</a></code></p>
            <p><strong>Чат (bridge):</strong><br>
            <code>POST {server_url}/api/bridge/chat</code></p>
            <p><strong>Редактор ассистента:</strong><br>
            <code><a href="{server_url}/assistant/{assistant.id}">{server_url}/assistant/{assistant.id}</a></code></p>
        </div>
    </div>
</body>
</html>"""


@app.route('/api/bridge/chat', methods=['POST', 'OPTIONS'])
def bridge_chat():
    if request.method == 'OPTIONS':
        return _with_cors(jsonify({'ok': True}))

    data = request.get_json(silent=True) if request.is_json else {}

    if request.is_json:
        chat_id = int(data.get('chat_id')) if isinstance(data, dict) and data.get('chat_id') is not None else None
        assistant_id = int(data.get('assistant_id')) if isinstance(data, dict) and data.get('assistant_id') is not None else None
        external_session_id = data.get('session_id') if isinstance(data, dict) else None
        raw_user_input = (data.get('message') or '').strip() if isinstance(data, dict) else ''
        game_context = data.get('game_context') if isinstance(data, dict) else {}
    else:
        chat_id = request.form.get('chat_id', type=int)
        assistant_id = request.form.get('assistant_id', type=int)
        external_session_id = request.form.get('session_id', type=str)
        raw_user_input = (request.form.get('message') or '').strip()
        game_context_raw = request.form.get('game_context', '{}')
        try:
            game_context = json.loads(game_context_raw) if game_context_raw else {}
        except Exception:
            game_context = {}

        if 'audio_blob' in request.files:
            audio_file = request.files['audio_blob']
            filename = f"{uuid.uuid4()}.webm"
            temp_path = os.path.join("temp_audio", filename)
            os.makedirs("temp_audio", exist_ok=True)
            audio_file.save(temp_path)
            if whisper_model is not None:
                result = whisper.transcribe(whisper_model, temp_path, fp16=False)
                recognized = result['text'].strip() if result.get('text') else ''
                raw_user_input = (raw_user_input + " " + recognized).strip()

    if not raw_user_input:
        return _with_cors(jsonify({'error': 'message is required'})), 400

    try:
        chat_session = _resolve_bridge_chat(
            chat_id=chat_id,
            assistant_id=assistant_id,
            external_session_id=external_session_id,
        )
    except ValueError as err:
        return _with_cors(jsonify({'error': str(err)})), 400

    chat_id = chat_session.id
    assistant = chat_session.assistant

    # --- Режим живого оператора ---
    if chat_session.status in ('waiting', 'operator'):
        user_message = Message(chat_id=chat_id, role='user', content=raw_user_input)
        db.session.add(user_message)
        db.session.commit()
        return _with_cors(jsonify({
            'chat_id': chat_id, 'assistant_id': assistant.id, 'user_text': raw_user_input,
            'ai_text': '', 'audio_url': '', 'status': chat_session.status,
            'user_message_id': user_message.id,
        }))

    if HANDOFF_RE.search(raw_user_input):
        user_message = Message(chat_id=chat_id, role='user', content=raw_user_input)
        db.session.add(user_message)
        _set_chat_status(chat_session, 'waiting')
        db.session.commit()
        return _with_cors(jsonify({
            'chat_id': chat_id, 'assistant_id': assistant.id, 'user_text': raw_user_input,
            'ai_text': 'Конечно! Подключаю живого оператора — он ответит здесь же, в этом окне.',
            'audio_url': '', 'status': 'waiting', 'user_message_id': user_message.id,
        }))

    try:
        context_lines = []
        if isinstance(game_context, dict):
            for key, value in game_context.items():
                context_lines.append(f"- {key}: {value}")

        if context_lines:
            bridge_context = (
                "[Контекст страницы, на которой установлен виджет]\n"
                + "\n".join(context_lines)
                + "\n\nЭто точные данные, рассчитанные сайтом (например, игровым движком). "
                  "Опирайся только на них: не придумывай ходы, цифры и факты, которых нет в контексте. "
                  "Если пользователь спрашивает совет — назови рекомендованный вариант из данных и коротко объясни, почему он хорош."
            )
        else:
            bridge_context = None

        conversation_history, _ = build_conversation_messages(
            assistant=assistant,
            chat_id=chat_id,
            raw_user_input=raw_user_input,
            extra_context=bridge_context
        )

        generated = call_llm_completion(conversation_history, assistant=assistant)
        raw_ai_response = clean_ai_response(generated)

        user_message = Message(chat_id=chat_id, role='user', content=raw_user_input)
        ai_message = Message(chat_id=chat_id, role='assistant', content=raw_ai_response)
        db.session.add(user_message)
        db.session.add(ai_message)
        db.session.commit()
        user_message_id, ai_message_id = user_message.id, ai_message.id

        audio_url = ""
        text_for_tts = prepare_text_for_tts(raw_ai_response)
        if active_silero_model and text_for_tts:
            try:
                output_wav_path = 'static/response.wav'
                audio_tensor = active_silero_model.apply_tts(
                    text=text_for_tts,
                    speaker=assistant.tts_speaker,
                    sample_rate=config.SILERO_SAMPLE_RATE,
                )
                torchaudio.save(output_wav_path, audio_tensor.unsqueeze(0).cpu(), config.SILERO_SAMPLE_RATE)
                audio_url = f'/{output_wav_path}?v={uuid.uuid4()}'
            except Exception as tts_e:
                print(f"!!! TTS error in bridge_chat: {tts_e}")

        response = jsonify({
            'chat_id': chat_id,
            'assistant_id': assistant.id,
            'user_text': raw_user_input,
            'ai_text': raw_ai_response,
            'audio_url': audio_url,
            'game_context': game_context,
            'status': 'ai',
            'user_message_id': user_message_id,
            'ai_message_id': ai_message_id,
        })
        return _with_cors(response)

    except Exception as e:
        db.session.rollback()
        print(f"!!! ОШИБКА bridge_chat: {e}")
        response = jsonify({'error': 'bridge chat failed', 'details': str(e)})
        return _with_cors(response), 500


@app.route('/boredom_phrase/<int:assistant_id>')
def get_boredom_phrase(assistant_id):
    assistant = db.get_or_404(Assistant, assistant_id)
    if not assistant.boredom_phrases:
        return jsonify({"error": "No phrases available"}), 404
    phrase = random.choice(assistant.boredom_phrases)
    try:
        if active_silero_model:
            output_wav_path = "static/response.wav"
            text_for_tts = prepare_text_for_tts(phrase.text)
            audio_tensor = active_silero_model.apply_tts(text=text_for_tts, speaker=assistant.tts_speaker, sample_rate=config.SILERO_SAMPLE_RATE)
            torchaudio.save(output_wav_path, audio_tensor.unsqueeze(0).cpu(), config.SILERO_SAMPLE_RATE)
            audio_url = f'/{output_wav_path}?v={uuid.uuid4()}'
            return jsonify({"text": phrase.text, "audio_url": audio_url})
        else:
            return jsonify({"text": phrase.text, "audio_url": ""})
    except Exception as e:
        print(f"!!! ОШИБКА генерации фразы скуки: {e}")
        return jsonify({"text": phrase.text, "audio_url": ""})


@app.route('/boredom_phrase/generate', methods=['POST'])
def generate_boredom_phrase():
    data = request.json or {}
    assistant_id = data.get('assistant_id')
    chat_id = data.get('chat_id')

    if not assistant_id or not chat_id:
        return jsonify({"error": "Assistant ID and Chat ID are required"}), 400

    assistant = db.get_or_404(Assistant, assistant_id)

    boredom_instruction = (
        "[СИСТЕМНАЯ ИНСТРУКЦИЯ] "
        "Пользователь долго молчит. Оставаясь в рамках своей роли и характера, "
        "придумай и скажи одну короткую, живую фразу, чтобы привлечь его внимание. "
        "Ответь только самой фразой без лишних слов."
    )

    conversation_history, _ = build_conversation_messages(
        assistant=assistant,
        chat_id=chat_id,
        raw_user_input=boredom_instruction
    )

    try:
        generated = call_llm_completion(conversation_history, assistant=assistant, temperature=0.8)
        generated_text_with_commands = clean_ai_response(generated)
        text_for_tts = prepare_text_for_tts(generated_text_with_commands)

        audio_url = ""
        if active_silero_model and text_for_tts:
            try:
                output_wav_path = "static/response.wav"
                audio_tensor = active_silero_model.apply_tts(text=text_for_tts, speaker=assistant.tts_speaker, sample_rate=config.SILERO_SAMPLE_RATE)
                torchaudio.save(output_wav_path, audio_tensor.unsqueeze(0).cpu(), config.SILERO_SAMPLE_RATE)
                audio_url = f'/{output_wav_path}?v={uuid.uuid4()}'
            except Exception as e:
                print(f"!!! TTS error in boredom generation: {e}")

        return jsonify({"text": generated_text_with_commands, "audio_url": audio_url})

    except Exception as e:
        print(f"!!! ОШИБКА генерации фразы скуки через LLM: {e}")
        return jsonify({"text": "Эй, ты где?", "audio_url": ""})


@app.route('/message/delete/<int:message_id>', methods=['POST'])
def delete_message(message_id):
    msg = db.get_or_404(Message, message_id)
    if msg.audio_url and os.path.exists(msg.audio_url):
        try:
            os.remove(msg.audio_url)
        except OSError as e:
            print(f"Ошибка удаления аудиофайла: {e}")
    db.session.delete(msg)
    db.session.commit()
    return jsonify({'success': True})


@app.route('/message/update/<int:message_id>', methods=['POST'])
def update_message(message_id):
    msg = db.get_or_404(Message, message_id)
    new_content = request.json.get('content')
    if new_content:
        msg.content = new_content
        db.session.commit()
        return jsonify({'success': True, 'new_content': new_content})
    return jsonify({'error': 'No content provided'}), 400


@app.route('/chat/<int:chat_id>/clear', methods=['POST'])
def clear_chat(chat_id):
    chat = db.get_or_404(Chat, chat_id)
    try:
        for msg in chat.messages:
            if msg.audio_url and os.path.exists(msg.audio_url):
                os.remove(msg.audio_url)
        Message.query.filter_by(chat_id=chat_id).delete()
        db.session.commit()
        return jsonify({'success': True})
    except Exception as e:
        db.session.rollback()
        print(f"!!! ОШИБКА очистки чата: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/assistant/<int:assistant_id>')
@admin_required
def edit_assistant(assistant_id):
    assistant = db.get_or_404(Assistant, assistant_id)
    api_settings = get_ai_settings()
    tts_models_dir = os.path.dirname(config.SILERO_MODEL_PATH)
    tts_models = []
    if os.path.exists(tts_models_dir):
        tts_models = [f.replace('.pt', '') for f in os.listdir(tts_models_dir) if f.endswith('.pt')]

    current_model_name = os.path.basename(assistant.tts_model_path).replace('.pt', '') if assistant.tts_model_path else (tts_models[0] if tts_models else None)
    current_speakers = MODEL_SPEAKERS.get(current_model_name, [])

    return render_template(
        'dashboard/editor.html',
        page='assistants',
        assistant=assistant,
        live2d_models=list_live2d_models(),
        models3d=list_models3d(),
        tts_models=tts_models,
        current_speakers=current_speakers,
        all_speakers_json=json.dumps(MODEL_SPEAKERS),
        boredom_phrases=assistant.boredom_phrases,
        api_settings=api_settings,
        avatar_json={**avatar_payload(assistant), 'layout': parse_layout(assistant.widget_layout),
                     'mode': assistant.widget_mode or 'popup'},
        server_url=request.host_url.rstrip('/'),
    )


@app.route('/assistant/add', methods=['GET'])
@admin_required
def add_assistant():
    avatar_type = request.args.get('type', 'live2d')
    if avatar_type not in ('live2d', 'gif', 'text', '3d'):
        avatar_type = 'live2d'
    default_prompt = load_default_system_prompt()
    type_names = {'live2d': 'Новый Live2D ассистент', 'gif': 'Новый GIF ассистент', 'text': 'Новый чат-бот', '3d': 'Новый 3D ассистент'}
    first_live2d = ''
    if avatar_type == 'live2d':
        models = list_live2d_models()
        first_live2d = models[0]['path'] if models else ''
    new_assistant = Assistant(
        name=request.args.get('name') or type_names[avatar_type],
        description="Настройте меня...",
        system_prompt=default_prompt,
        model_name=None,
        avatar_type=avatar_type,
        live2d_model_path=first_live2d,
        tts_model_path='static/silero_models/v4_ru.pt',
        tts_speaker='kseniya',
    )
    if avatar_type == '3d':
        models = list_models3d()
        new_assistant.model3d = json.dumps({'url': models[0]['path'] if models else '', 'scale': 1.0, 'offset_y': 0, 'rotate_y': 0, 'follow': True})
    db.session.add(new_assistant)
    db.session.commit()
    return redirect(url_for('edit_assistant', assistant_id=new_assistant.id))


@app.route('/assistant/<int:assistant_id>/update', methods=['POST'])
def update_assistant(assistant_id):
    assistant = db.get_or_404(Assistant, assistant_id)
    
    assistant.name = request.form.get('name')
    assistant.description = request.form.get('description')
    assistant.system_prompt = request.form.get('system_prompt')
    assistant.model_name = request.form.get('model_name', '').strip() or None
    assistant.live2d_model_path = request.form.get('live2d_model')
    assistant.tts_model_path = f"static/silero_models/{request.form.get('tts_model')}.pt" if request.form.get('tts_model') else assistant.tts_model_path
    assistant.tts_speaker = request.form.get('tts_speaker')
    assistant.scale = request.form.get('scale', 2.4, type=float)
    assistant.pos_x = request.form.get('pos_x', 0, type=int)
    assistant.pos_y = request.form.get('pos_y', 50, type=int)
    assistant.memory_depth = request.form.get('memory_depth', 10, type=int)
    assistant.mouth_min_open = request.form.get('mouth_min_open', 0.05, type=float)
    assistant.mouth_max_open = request.form.get('mouth_max_open', 0.8, type=float)
    assistant.mouth_jitter_strength = request.form.get('mouth_jitter_strength', 0.05, type=float)
    assistant.mouth_jitter_speed = request.form.get('mouth_jitter_speed', 50.0, type=float)
    
    assistant.boredom_enabled = 'boredom_enabled' in request.form
    assistant.patting_enabled = 'patting_enabled' in request.form
    
    assistant.boredom_min_time = request.form.get('boredom_min_time', 30, type=int)
    assistant.boredom_max_time = request.form.get('boredom_max_time', 120, type=int)
    
    assistant.patting_tilt_angle = request.form.get('patting_tilt_angle', 15.0, type=float)
    assistant.patting_eye_close = request.form.get('patting_eye_close', 0.8, type=float)
    assistant.patting_follow_strength = request.form.get('patting_follow_strength', 0.1, type=float)

    assistant.boredom_use_llm = 'boredom_use_llm' in request.form
    if request.form.get('widget_mode') in ('popup', 'card', 'novel'):
        assistant.widget_mode = request.form.get('widget_mode')
    if 'widget_layout' in request.form:
        try:
            assistant.widget_layout = json.dumps(json.loads(request.form.get('widget_layout') or '{}'), ensure_ascii=False)
        except ValueError:
            pass
    assistant.greeting_phrase = request.form.get('greeting_phrase', 'Привет! Чем могу помочь? 😊')
    assistant.widget_primary_color = request.form.get('widget_primary_color', '#667eea')
    assistant.widget_bg_color = request.form.get('widget_bg_color', 'rgba(15,15,30,0.92)')
    assistant.widget_text_color = request.form.get('widget_text_color', '#e0e0f0')
    assistant.widget_user_bubble_color = request.form.get('widget_user_bubble_color', '#667eea')

    if request.form.get('avatar_type') in ('live2d', 'gif', 'text', '3d'):
        assistant.avatar_type = request.form.get('avatar_type')
    if 'model3d_url' in request.form:
        assistant.model3d = json.dumps({
            'url': request.form.get('model3d_url', ''),
            'scale': request.form.get('model3d_scale', 1.0, type=float),
            'offset_y': request.form.get('model3d_offset_y', 0, type=float),
            'rotate_y': request.form.get('model3d_rotate_y', 0, type=float),
            'follow': 'model3d_follow' in request.form,
        })
    if request.form.get('gif_mode') in ('frames', 'swap'):
        assistant.gif_mode = request.form.get('gif_mode')
    assistant.gif_scale = request.form.get('gif_scale', assistant.gif_scale or 1.0, type=float)
    assistant.gif_offset_y = request.form.get('gif_offset_y', assistant.gif_offset_y or 0, type=int)
    assistant.gif_noise_floor = request.form.get('gif_noise_floor', assistant.gif_noise_floor or 0.008, type=float)
    assistant.gif_smoothing = request.form.get('gif_smoothing', assistant.gif_smoothing or 0.35, type=float)
    if 'gif_mode' in request.form:
        assistant.gif_breathing = 'gif_breathing' in request.form

    db.session.commit()
    if request.headers.get('X-Requested-With') == 'fetch':
        return jsonify({'success': True})
    return redirect(url_for('edit_assistant', assistant_id=assistant.id, saved=1))


@app.route('/assistant/<int:assistant_id>/delete', methods=['POST'])
def delete_assistant(assistant_id):
    assistant = db.get_or_404(Assistant, assistant_id)
    default_avatar_path = 'Img/default_avatar.png'
    if assistant.photo_url != default_avatar_path:
        avatar_to_delete = os.path.join('static', assistant.photo_url)
        if os.path.exists(avatar_to_delete):
            try:
                os.remove(avatar_to_delete)
            except OSError as e:
                print(f"!!! ОШИБКА при удалении файла аватара: {e}")
    db.session.delete(assistant)
    db.session.commit()
    return redirect(request.form.get('next') or url_for('dash_assistants'))
    

@app.route('/assistant/<int:assistant_id>/upload_avatar', methods=['POST'])
def upload_avatar(assistant_id):
    assistant = db.get_or_404(Assistant, assistant_id)
    if 'avatar' not in request.files:
        return jsonify({"error": "No file part"}), 400
    file = request.files['avatar']
    if file.filename == '':
        return jsonify({"error": "No selected file"}), 400
    if file:
        default_avatar_path = 'Img/default_avatar.png'
        if assistant.photo_url != default_avatar_path:
            old_avatar_path = os.path.join('static', assistant.photo_url)
            if os.path.exists(old_avatar_path):
                os.remove(old_avatar_path)
        _, extension = os.path.splitext(file.filename)
        new_filename = f"{assistant.id}{extension if extension else '.png'}"
        save_path = os.path.join(app.config['UPLOAD_FOLDER'], new_filename)
        file.save(save_path)
        assistant.photo_url = f'Live2d_Avatars/{new_filename}'
        db.session.commit()
        return jsonify({"success": True, "new_photo_url": url_for('static', filename=assistant.photo_url)})
    return jsonify({"error": "File upload failed"}), 500


@app.route('/assistant/<int:assistant_id>/set_default_avatar', methods=['POST'])
def set_default_avatar(assistant_id):
    assistant = db.get_or_404(Assistant, assistant_id)
    default_avatar_path_db = 'Img/default_avatar.png'
    if assistant.photo_url != default_avatar_path_db:
        old_avatar_path_os = os.path.join('static', assistant.photo_url)
        if os.path.exists(old_avatar_path_os):
            try:
                os.remove(old_avatar_path_os)
            except Exception as e:
                print(f"!!! ОШИБКА при удалении старого аватара: {e}")
    assistant.photo_url = default_avatar_path_db
    db.session.commit()
    return jsonify({"success": True, "new_photo_url": url_for('static', filename=default_avatar_path_db)})


@app.route('/assistant/test_tts', methods=['POST'])
def test_tts():
    data = request.json or {}
    text_to_speak = data.get('text')
    tts_model_name = data.get('model_name')
    tts_speaker_name = data.get('speaker_name')
    if not all([text_to_speak, tts_model_name, tts_speaker_name]):
        return jsonify({"error": "Missing data"}), 400
    try:
        tts_model_path = os.path.join('static', 'silero_models', f'{tts_model_name}.pt')
        if not os.path.exists(tts_model_path):
            return jsonify({"error": "Model file not found"}), 404
        test_model = torch.package.PackageImporter(tts_model_path).load_pickle("tts_models", "model")
        test_model.to(device)
        output_wav_path = os.path.join("static", "temp_test_speech.wav")
        cleaned_text = prepare_text_for_tts(text_to_speak)
        audio_tensor = test_model.apply_tts(text=cleaned_text, speaker=tts_speaker_name, sample_rate=config.SILERO_SAMPLE_RATE)
        torchaudio.save(output_wav_path, audio_tensor.unsqueeze(0).cpu(), config.SILERO_SAMPLE_RATE)
        audio_url = f'/{output_wav_path}?v={uuid.uuid4()}'
        return jsonify({"audio_url": audio_url})
    except Exception as e:
        print(f"!!! ОШИБКА ТЕСТИРОВАНИЯ TTS: {e}")
        return jsonify({"error": str(e)}), 500


@app.route('/assistant/boredom/add/<int:assistant_id>', methods=['POST'])
def add_boredom_phrase(assistant_id):
    text = request.json.get('text')
    if not text:
        return jsonify({'error': 'Text is required'}), 400
    new_phrase = BoredomPhrase(text=text, assistant_id=assistant_id)
    db.session.add(new_phrase)
    db.session.commit()
    return jsonify({'id': new_phrase.id, 'text': new_phrase.text})


@app.route('/assistant/boredom/delete/<int:phrase_id>', methods=['POST'])
def delete_boredom_phrase(phrase_id):
    phrase = db.get_or_404(BoredomPhrase, phrase_id)
    db.session.delete(phrase)
    db.session.commit()
    return jsonify({'success': True})


# =======================================================
#      B2B-КАБИНЕТ: ЛЕНДИНГ, ВХОД, РАЗДЕЛЫ, ОПЕРАТОР
# =======================================================

HANDOFF_RE = re.compile(r'(позов\w*|подключ\w*|соедин\w*|нуж\w*|хочу|дайте)\s+(с\s+)?(живого\s+|реального\s+)?(оператор\w*|человек\w*|менеджер\w*|поддержк\w*)', re.IGNORECASE)

AVATAR_TYPES = [
    {'id': 'live2d', 'name': 'Live2D', 'ready': True,
     'desc': 'Живой аниме-персонаж: моргает, следит за курсором, двигает головой по командам и шевелит губами в такт голосу.'},
    {'id': 'gif', 'name': 'GIF / PNG-тубер', 'ready': True,
     'desc': 'Любая картинка или GIF. Рот открывается по громкости речи, есть «дыхание» и реакции на команды.'},
    {'id': 'text', 'name': 'Чат-бот без аватара', 'ready': True,
     'desc': 'Классический чат-виджет с голосом и всеми возможностями ИИ, но без персонажа.'},
    {'id': '3d', 'name': '3D-модель (бета)', 'ready': True,
     'desc': 'Модель .glb: дышит, поворачивается к курсору, кивает по командам и подпрыгивает в такт речи.'},
    {'id': 'vrm', 'name': '3D VRM со скелетом', 'ready': False,
     'desc': 'Персонаж VRM с мимикой, моргающими глазами и движением губ.'},
    {'id': 'video', 'name': 'Видео-аватар', 'ready': False,
     'desc': 'Реалистичный говорящий человек, сгенерированный по фотографии.'},
    {'id': 'voice', 'name': 'Голосовой агент', 'ready': False,
     'desc': 'Только голос: звонки и голосовое меню без визуальной части.'},
]


def list_live2d_models():
    models = []
    live2d_models_dir = os.path.join('static', 'Live2d_Models')
    if os.path.exists(live2d_models_dir):
        for folder_name in sorted(os.listdir(live2d_models_dir)):
            model_folder_path = os.path.join(live2d_models_dir, folder_name)
            if os.path.isdir(model_folder_path):
                for filename in os.listdir(model_folder_path):
                    if filename.endswith('.model3.json'):
                        models.append({'name': folder_name, 'path': f'/static/Live2d_Models/{folder_name}/{filename}'})
                        break
    return models


def _json_or(raw, default):
    try:
        val = json.loads(raw) if raw else default
        return val if isinstance(val, type(default)) else default
    except ValueError:
        return default


def keyed_url(url, version):
    """URL кадра после хромакея: frame_000.png -> key_frame_000.png"""
    folder, name = url.rsplit('/', 1)
    return f"{folder}/key_{name.split('?')[0]}?v={version}"


MODELS3D_DIR = os.path.join('static', 'models3d')


def list_models3d():
    out = []
    if os.path.isdir(MODELS3D_DIR):
        for name in sorted(os.listdir(MODELS3D_DIR)):
            if name.lower().endswith(('.glb', '.gltf')):
                size = os.path.getsize(os.path.join(MODELS3D_DIR, name))
                out.append({'name': os.path.splitext(name)[0], 'path': f'/static/models3d/{name}', 'size_mb': round(size / 1048576, 1)})
    return out


def avatar_payload(assistant):
    """Данные о внешности ассистента для фронтенда (студия, виджет, редактор)."""
    all_frames = _json_or(assistant.gif_frames, [])
    disabled = set(_json_or(assistant.gif_disabled, []))
    chroma = _json_or(assistant.gif_chroma, {})
    keyed_on = bool(chroma.get('enabled') and chroma.get('version'))
    shown = [keyed_url(u, chroma['version']) if keyed_on else u for u in all_frames]
    frames = [u for i, u in enumerate(shown) if i not in disabled] or shown[:1]
    idle, talk = assistant.gif_idle_url or '', assistant.gif_talk_url or ''
    if keyed_on:
        idle = chroma.get('idle_key') or idle
        talk = chroma.get('talk_key') or talk
    m3 = _json_or(assistant.model3d, {})
    return {
        'avatar_type': assistant.avatar_type or 'live2d',
        'model3d': {
            'url': m3.get('url', ''),
            'scale': m3.get('scale', 1.0),
            'offset_y': m3.get('offset_y', 0),
            'rotate_y': m3.get('rotate_y', 0),
            'follow': m3.get('follow', True),
        },
        'gif': {
            'mode': assistant.gif_mode or 'frames',
            'source_url': assistant.gif_source_url or '',
            'frames': frames,
            'all_frames': shown,
            'original_frames': all_frames,
            'disabled': sorted(disabled),
            'idle_url': idle,
            'talk_url': talk,
            'idle_original': assistant.gif_idle_url or '',
            'talk_original': assistant.gif_talk_url or '',
            'chroma': {k: chroma.get(k) for k in ('enabled', 'color', 'tolerance', 'softness', 'despill')},
            'scale': assistant.gif_scale or 1.0,
            'offset_y': assistant.gif_offset_y or 0,
            'noise_floor': assistant.gif_noise_floor if assistant.gif_noise_floor is not None else 0.008,
            'smoothing': assistant.gif_smoothing if assistant.gif_smoothing is not None else 0.35,
            'breathing': True if assistant.gif_breathing is None else bool(assistant.gif_breathing),
        }
    }


def parse_layout(raw):
    try:
        data = json.loads(raw) if raw else {}
        return data if isinstance(data, dict) else {}
    except ValueError:
        return {}


def _set_chat_status(chat, status):
    labels = {
        'waiting': 'Клиент запросил живого оператора',
        'operator': 'Оператор подключился к диалогу',
        'ai': 'Диалог возвращён ассистенту',
    }
    if chat.status == status:
        return
    chat.status = status
    db.session.add(Message(chat_id=chat.id, role='system', content=labels.get(status, status)))


def chat_display_name(chat):
    if chat.name and chat.name.startswith('Bridge session '):
        return 'Посетитель #' + chat.name.replace('Bridge session ', '')[:4].upper()
    if chat.name and chat.name.startswith('Bridge '):
        return 'Посетитель сайта'
    return chat.name


def serialize_message(m):
    return {
        'id': m.id, 'role': m.role,
        'content': re.sub(r'【.*?】', '', clean_ai_response(m.content) if m.role == 'assistant' else m.content).strip(),
        'timestamp': (m.timestamp.isoformat() + 'Z') if m.timestamp else None,
    }


def serialize_chat(chat, with_last=True):
    last = Message.query.filter_by(chat_id=chat.id).order_by(Message.id.desc()).first() if with_last else None
    count = Message.query.filter_by(chat_id=chat.id).filter(Message.role.in_(['user', 'assistant', 'operator'])).count()
    unread = Message.query.filter(Message.chat_id == chat.id, Message.role == 'user', Message.id > (chat.operator_seen_id or 0)).count() \
        if chat.status in ('waiting', 'operator') else 0
    source = chat.source or ('widget' if (chat.name or '').startswith('Bridge') else 'studio')
    return {
        'id': chat.id,
        'name': chat_display_name(chat),
        'raw_name': chat.name,
        'status': chat.status or 'ai',
        'source': source,
        'assistant': {'id': chat.assistant.id, 'name': chat.assistant.name,
                      'photo_url': url_for('static', filename=chat.assistant.photo_url)} if chat.assistant else None,
        'messages_count': count,
        'unread': unread,
        'last_message': serialize_message(last) if last else None,
        'updated_at': (last.timestamp.isoformat() + 'Z') if last and last.timestamp else
                      ((chat.created_at.isoformat() + 'Z') if chat.created_at else None),
    }


def current_user():
    user = User.query.first()
    if not user:
        user = User()
        db.session.add(user)
        db.session.commit()
    return user


@app.context_processor
def inject_globals():
    ctx = {'avatar_types': AVATAR_TYPES}
    if session.get('is_admin'):
        try:
            ctx['admin_user'] = current_user()
            ctx['waiting_count'] = Chat.query.filter(Chat.status == 'waiting').count()
        except Exception:
            pass
    return ctx


@app.route('/')
def landing():
    assistants = Assistant.query.all()
    showcase = next((a for a in assistants if (a.avatar_type or 'live2d') == 'live2d' and a.live2d_model_path), None)
    gif_showcase = next((a for a in assistants if a.gif_source_url or a.gif_talk_url), None)
    others = [a for a in assistants if a is not showcase]
    return render_template('landing.html', showcase=showcase, gif_showcase=gif_showcase, others=others,
                           assistants_count=len(assistants),
                           is_admin=bool(session.get('is_admin')))


@app.route('/demo')
@app.route('/demo/<int:assistant_id>')
def demo_site(assistant_id=None):
    """Демо-магазин с установленным виджетом — чтобы проверить ассистента и оператора как посетитель."""
    assistant = db.session.get(Assistant, assistant_id) if assistant_id else Assistant.query.first()
    return render_template('demo_site.html', assistant=assistant, server_url=request.host_url.rstrip('/'),
                           assistants=Assistant.query.all())


@app.route('/testsite')
def test_site():
    """Тестовый сайт: посмотреть любого ассистента в любом виде на красивой странице."""
    assistants = Assistant.query.order_by(Assistant.id.asc()).all()
    assistant = db.session.get(Assistant, request.args.get('a', type=int) or 0) or (assistants[0] if assistants else None)
    return render_template('test_site.html', assistant=assistant, assistants=assistants,
                           server_url=request.host_url.rstrip('/'), is_admin=bool(session.get('is_admin')))


@app.route('/login/admin', methods=['POST', 'GET'])
def login_admin():
    session.permanent = True
    session['is_admin'] = True
    return redirect(url_for('dash_assistants'))


@app.route('/logout')
def logout():
    session.clear()
    return redirect(url_for('landing'))


@app.route('/app')
@admin_required
def dash_home():
    return redirect(url_for('dash_assistants'))


@app.route('/app/assistants')
@admin_required
def dash_assistants():
    assistants = Assistant.query.order_by(Assistant.id.asc()).all()
    stats = {}
    for a in assistants:
        chat_ids = [c.id for c in a.chats]
        stats[a.id] = {
            'chats': len(chat_ids),
            'messages': Message.query.filter(Message.chat_id.in_(chat_ids)).count() if chat_ids else 0,
        }
    return render_template('dashboard/assistants.html', page='assistants', assistants=assistants, stats=stats,
                           live2d_models=list_live2d_models())


@app.route('/app/dialogs')
@app.route('/app/dialogs/<int:chat_id>')
@admin_required
def dash_dialogs(chat_id=None):
    assistants = Assistant.query.all()
    return render_template('dashboard/dialogs.html', page='dialogs', initial_chat_id=chat_id, assistants=assistants)


@app.route('/app/analytics')
@admin_required
def dash_analytics():
    return render_template('dashboard/analytics.html', page='analytics')


@app.route('/app/docs')
@admin_required
def dash_docs():
    assistants = Assistant.query.all()
    return render_template('dashboard/docs.html', page='docs', assistants=assistants,
                           server_url=request.host_url.rstrip('/'))


@app.route('/app/settings')
@admin_required
def dash_settings():
    return render_template('dashboard/settings.html', page='settings', api_settings=get_ai_settings())


@app.route('/app/billing')
@admin_required
def dash_billing():
    month_start = datetime.utcnow().replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    usage = {
        'messages': Message.query.filter(Message.timestamp >= month_start, Message.role == 'assistant').count(),
        'assistants': Assistant.query.count(),
        'dialogs': Chat.query.count(),
    }
    return render_template('dashboard/billing.html', page='billing', usage=usage)


@app.route('/app/account')
@admin_required
def dash_account():
    return render_template('dashboard/account.html', page='account', user=current_user())


# ---------- API кабинета ----------

@app.route('/api/admin/summary')
@admin_required
def api_admin_summary():
    return jsonify({
        'waiting': Chat.query.filter(Chat.status == 'waiting').count(),
        'operator': Chat.query.filter(Chat.status == 'operator').count(),
    })


@app.route('/api/admin/dialogs')
@admin_required
def api_admin_dialogs():
    chats = Chat.query.all()
    data = [serialize_chat(c) for c in chats]
    data.sort(key=lambda c: (c['status'] != 'waiting', -(int(datetime.fromisoformat(c['updated_at'][:-1]).timestamp()) if c['updated_at'] else 0)))
    return jsonify(data)


@app.route('/api/admin/dialogs/<int:chat_id>')
@admin_required
def api_admin_dialog(chat_id):
    chat = db.get_or_404(Chat, chat_id)
    after = request.args.get('after', 0, type=int)
    msgs = Message.query.filter(Message.chat_id == chat_id, Message.id > after).order_by(Message.id.asc()).all()
    if msgs and chat.status in ('waiting', 'operator'):
        chat.operator_seen_id = max(chat.operator_seen_id or 0, msgs[-1].id)
        db.session.commit()
    return jsonify({'chat': serialize_chat(chat), 'messages': [serialize_message(m) for m in msgs]})


@app.route('/api/admin/dialogs/<int:chat_id>/status', methods=['POST'])
@admin_required
def api_admin_dialog_status(chat_id):
    chat = db.get_or_404(Chat, chat_id)
    status = (request.get_json(silent=True) or {}).get('status')
    if status not in ('ai', 'waiting', 'operator'):
        return jsonify({'error': 'bad status'}), 400
    _set_chat_status(chat, status)
    db.session.commit()
    return jsonify({'success': True, 'chat': serialize_chat(chat)})


@app.route('/api/admin/dialogs/<int:chat_id>/reply', methods=['POST'])
@admin_required
def api_admin_dialog_reply(chat_id):
    chat = db.get_or_404(Chat, chat_id)
    text = ((request.get_json(silent=True) or {}).get('text') or '').strip()
    if not text:
        return jsonify({'error': 'text required'}), 400
    if chat.status != 'operator':
        _set_chat_status(chat, 'operator')
    msg = Message(chat_id=chat.id, role='operator', content=text)
    db.session.add(msg)
    db.session.commit()
    return jsonify({'success': True, 'message': serialize_message(msg)})


@app.route('/api/admin/dialogs/<int:chat_id>', methods=['DELETE'])
@admin_required
def api_admin_dialog_delete(chat_id):
    chat = db.get_or_404(Chat, chat_id)
    db.session.delete(chat)
    db.session.commit()
    return jsonify({'success': True})


@app.route('/api/admin/analytics')
@admin_required
def api_admin_analytics():
    days = max(7, min(90, request.args.get('days', 14, type=int)))
    since = (datetime.utcnow() - timedelta(days=days - 1)).replace(hour=0, minute=0, second=0, microsecond=0)
    msgs = Message.query.filter(Message.timestamp >= since).all()
    all_chats = Chat.query.all()
    series = {}
    for i in range(days):
        d = (since + timedelta(days=i)).strftime('%Y-%m-%d')
        series[d] = {'date': d, 'user': 0, 'assistant': 0, 'operator': 0}
    hours = [0] * 24
    by_assistant = {}
    active_chats = set()
    for m in msgs:
        key = m.timestamp.strftime('%Y-%m-%d')
        if key in series and m.role in ('user', 'assistant', 'operator'):
            series[key][m.role] += 1
        if m.role == 'user':
            hours[(m.timestamp.hour + 3) % 24] += 1  # МСК
        active_chats.add(m.chat_id)
    chat_map = {c.id: c for c in all_chats}
    for cid in active_chats:
        c = chat_map.get(cid)
        if c and c.assistant:
            by_assistant.setdefault(c.assistant.name, 0)
            by_assistant[c.assistant.name] += sum(1 for m in msgs if m.chat_id == cid and m.role in ('user', 'assistant'))
    total_user = sum(v['user'] for v in series.values())
    total_ai = sum(v['assistant'] for v in series.values())
    total_op = sum(v['operator'] for v in series.values())
    handoffs = len({m.chat_id for m in msgs if m.role == 'system' and 'оператор' in (m.content or '').lower() and 'запросил' in (m.content or '').lower()})
    widget_chats = sum(1 for cid in active_chats if chat_map.get(cid) and ((chat_map[cid].source == 'widget') or (chat_map[cid].name or '').startswith('Bridge')))
    return jsonify({
        'days': days,
        'kpi': {
            'dialogs': len(active_chats),
            'messages': total_user + total_ai + total_op,
            'user_messages': total_user,
            'ai_messages': total_ai,
            'operator_messages': total_op,
            'handoffs': handoffs,
            'automation': round(100 * total_ai / max(1, total_ai + total_op)),
            'avg_len': round((total_user + total_ai + total_op) / max(1, len(active_chats)), 1),
            'widget_share': round(100 * widget_chats / max(1, len(active_chats))),
        },
        'series': list(series.values()),
        'hours': hours,
        'by_assistant': sorted([{'name': k, 'value': v} for k, v in by_assistant.items()], key=lambda x: -x['value']),
        'all_time': {'dialogs': len(all_chats), 'messages': Message.query.count()},
    })


@app.route('/api/admin/account', methods=['POST'])
@admin_required
def api_admin_account():
    user = current_user()
    data = request.get_json(silent=True) or request.form.to_dict()
    for field in ('name', 'description', 'email', 'company'):
        if field in data:
            setattr(user, field, (data.get(field) or '').strip())
    db.session.commit()
    return jsonify({'success': True})


@app.route('/api/admin/account/avatar', methods=['POST', 'DELETE'])
@admin_required
def api_admin_account_avatar():
    user = current_user()
    os.makedirs(app.config['USER_AVATAR_FOLDER'], exist_ok=True)
    if user.avatar_url:
        old = os.path.join('static', user.avatar_url)
        if os.path.exists(old):
            try:
                os.remove(old)
            except OSError:
                pass
    if request.method == 'DELETE':
        user.avatar_url = None
        db.session.commit()
        return jsonify({'success': True, 'avatar_url': None})
    f = request.files.get('avatar')
    if not f:
        return jsonify({'error': 'no file'}), 400
    name = f"admin_{uuid.uuid4().hex[:8]}.png"
    f.save(os.path.join(app.config['USER_AVATAR_FOLDER'], name))
    user.avatar_url = f'user_avatars/{name}'
    db.session.commit()
    return jsonify({'success': True, 'avatar_url': url_for('static', filename=user.avatar_url)})


# ---------- GIF-ассистент ----------

def extract_gif_frames(src_path, out_dir, max_frames=48):
    """Раскладывает GIF на кадры PNG (как load_gif_frames в example.py). Нужен Pillow."""
    try:
        from PIL import Image, ImageSequence
    except ImportError:
        print('!!! Pillow не установлен — кадры GIF будут извлечены в браузере.')
        return []
    frames = []
    with Image.open(src_path) as im:
        all_frames = [f.convert('RGBA').copy() for f in ImageSequence.Iterator(im)]
    if not all_frames:
        return []
    step = max(1, len(all_frames) // max_frames + (1 if len(all_frames) % max_frames else 0)) if len(all_frames) > max_frames else 1
    for i, fr in enumerate(all_frames[::step]):
        name = f'frame_{i:03d}.png'
        fr.save(os.path.join(out_dir, name))
        frames.append(name)
    return frames


@app.route('/assistant/<int:assistant_id>/gif', methods=['POST'])
@admin_required
def upload_gif_asset(assistant_id):
    """slot: 'source' (GIF для режима «по громкости»), 'idle' или 'talk' (режим двух картинок)."""
    assistant = db.get_or_404(Assistant, assistant_id)
    slot = request.form.get('slot', 'source')
    f = request.files.get('file')
    if not f or not f.filename:
        return jsonify({'error': 'Файл не выбран'}), 400
    ext = os.path.splitext(f.filename)[1].lower() or '.gif'
    if ext not in ('.gif', '.png', '.jpg', '.jpeg', '.webp'):
        return jsonify({'error': 'Поддерживаются GIF, PNG, JPG и WEBP'}), 400
    folder = os.path.join(app.config['GIF_FOLDER'], str(assistant.id))
    os.makedirs(folder, exist_ok=True)
    stamp = uuid.uuid4().hex[:6]
    if slot == 'source':
        for old in os.listdir(folder):
            if old.startswith(('frame_', 'source_', 'key_frame_')):
                try:
                    os.remove(os.path.join(folder, old))
                except OSError:
                    pass
        fname = f'source_{stamp}{ext}'
        path = os.path.join(folder, fname)
        f.save(path)
        frames = extract_gif_frames(path, folder)
        assistant.gif_source_url = f'/static/gif_avatars/{assistant.id}/{fname}'
        assistant.gif_frames = json.dumps([f'/static/gif_avatars/{assistant.id}/{n}' for n in frames])
        assistant.gif_disabled = None
        if frames and not assistant.gif_idle_url:
            pass
    elif slot in ('idle', 'talk'):
        fname = f'{slot}_{stamp}{ext}'
        f.save(os.path.join(folder, fname))
        setattr(assistant, f'gif_{slot}_url', f'/static/gif_avatars/{assistant.id}/{fname}')
    else:
        return jsonify({'error': 'bad slot'}), 400
    chroma = _json_or(assistant.gif_chroma, {})
    if chroma.get('enabled'):
        run_chroma(assistant, chroma)
    db.session.commit()
    return jsonify({'success': True, **avatar_payload(assistant)})


@app.route('/assistant/<int:assistant_id>/gif/clear', methods=['POST'])
@admin_required
def clear_gif_asset(assistant_id):
    """Удалить загруженный GIF (slot=source) или картинку «молчит»/«говорит»."""
    assistant = db.get_or_404(Assistant, assistant_id)
    slot = (request.get_json(silent=True) or {}).get('slot') or request.form.get('slot', 'source')
    folder = os.path.join(app.config['GIF_FOLDER'], str(assistant.id))

    def _rm(url):
        if url and url.startswith('/static/gif_avatars/'):
            path = url.lstrip('/').split('?')[0]
            if os.path.exists(path):
                try:
                    os.remove(path)
                except OSError:
                    pass

    if slot == 'source':
        _rm(assistant.gif_source_url)
        if os.path.isdir(folder):
            for name in os.listdir(folder):
                if name.startswith(('frame_', 'key_frame_')):
                    _rm(f'/static/gif_avatars/{assistant.id}/{name}')
        assistant.gif_source_url = None
        assistant.gif_frames = None
    elif slot in ('idle', 'talk'):
        _rm(getattr(assistant, f'gif_{slot}_url'))
        setattr(assistant, f'gif_{slot}_url', None)
    db.session.commit()
    return jsonify({'success': True, **avatar_payload(assistant)})


@app.route('/assistant/<int:assistant_id>/model3d', methods=['POST'])
@admin_required
def upload_model3d(assistant_id):
    """Загрузка 3D-модели .glb для ассистента."""
    assistant = db.get_or_404(Assistant, assistant_id)
    f = request.files.get('file')
    if not f or not f.filename.lower().endswith('.glb'):
        return jsonify({'error': 'Нужен файл .glb'}), 400
    os.makedirs(MODELS3D_DIR, exist_ok=True)
    base = re.sub(r'[^\w\-]+', '_', os.path.splitext(os.path.basename(f.filename))[0]).strip('_') or 'model'
    name, i = f'{base}.glb', 1
    while os.path.exists(os.path.join(MODELS3D_DIR, name)):
        i += 1
        name = f'{base}_{i}.glb'
    f.save(os.path.join(MODELS3D_DIR, name))
    m3 = _json_or(assistant.model3d, {})
    m3['url'] = f'/static/models3d/{name}'
    assistant.model3d = json.dumps(m3)
    db.session.commit()
    return jsonify({'success': True, 'models': list_models3d(), **avatar_payload(assistant)})


@app.route('/assistant/<int:assistant_id>/gif/disabled', methods=['POST'])
@admin_required
def set_gif_disabled(assistant_id):
    """Отключённые кадры GIF не участвуют в анимации рта."""
    assistant = db.get_or_404(Assistant, assistant_id)
    n = len(_json_or(assistant.gif_frames, []))
    raw = (request.get_json(silent=True) or {}).get('disabled') or []
    disabled = sorted({int(i) for i in raw if str(i).lstrip('-').isdigit() and 0 <= int(i) < n})
    if n and len(disabled) >= n:
        return jsonify({'error': 'Нужно оставить хотя бы один кадр'}), 400
    assistant.gif_disabled = json.dumps(disabled)
    db.session.commit()
    return jsonify({'success': True, **avatar_payload(assistant)})


def chroma_key_image(img, color, tolerance, softness, despill):
    """Убирает фон выбранного цвета (хромакей). tolerance/softness — в процентах от максимального расстояния цвета."""
    from PIL import Image
    img = img.convert('RGBA')
    kr, kg, kb = color
    tol = tolerance / 100.0 * 441.7
    soft = max(1.0, softness / 100.0 * 441.7)
    dominant = max(range(3), key=lambda c: color[c])
    try:
        import numpy as np
        a = np.asarray(img).astype(np.float32)
        rgb, alpha = a[..., :3], a[..., 3]
        dist = np.sqrt(((rgb - np.array([kr, kg, kb], dtype=np.float32)) ** 2).sum(axis=2))
        k = np.clip((dist - tol) / soft, 0, 1)
        if despill and max(color) - sorted(color)[1] > 40:
            others = [c for c in range(3) if c != dominant]
            limit = np.maximum(rgb[..., others[0]], rgb[..., others[1]])
            # убираем цветной ореол только у края (рядом с порогом), чтобы не перекрасить зелёные детали персонажа
            edge = np.clip(1 - (dist - tol - soft) / (2 * soft + 1), 0, 1)
            rgb[..., dominant] = np.where(rgb[..., dominant] > limit, rgb[..., dominant] - (rgb[..., dominant] - limit) * edge, rgb[..., dominant])
        out = np.dstack([rgb, alpha * k]).clip(0, 255).astype(np.uint8)
        return Image.fromarray(out, 'RGBA')
    except ImportError:
        px = []
        for r, g, b, al in img.getdata():
            d = ((r - kr) ** 2 + (g - kg) ** 2 + (b - kb) ** 2) ** 0.5
            k = min(1.0, max(0.0, (d - tol) / soft))
            px.append((r, g, b, int(al * k)))
        out = Image.new('RGBA', img.size)
        out.putdata(px)
        return out


def _key_file(src_rel, dst_rel, params):
    """Применяет хромакей к файлу; анимированные картинки сохраняет как анимированный PNG."""
    from PIL import Image, ImageSequence
    with Image.open(src_rel) as im:
        frames = [chroma_key_image(f.copy(), *params) for f in ImageSequence.Iterator(im)]
        duration = im.info.get('duration', 80)
    if len(frames) > 1:
        frames[0].save(dst_rel, save_all=True, append_images=frames[1:], duration=duration, loop=0, format='PNG')
    else:
        frames[0].save(dst_rel, format='PNG')


def run_chroma(assistant, chroma):
    """Пересчитывает обработанные хромакеем кадры. Возвращает текст ошибки или None."""
    color_hex = (chroma.get('color') or '#00ff00').lstrip('#')
    color = tuple(int(color_hex[i:i + 2], 16) for i in (0, 2, 4))
    try:
        from PIL import Image  # noqa: F401
    except ImportError:
        return 'Для хромакея нужен Pillow: pip install Pillow'
    params = (color, chroma.get('tolerance', 25), chroma.get('softness', 10), chroma.get('despill', True))
    version = uuid.uuid4().hex[:6]
    try:
        for url in _json_or(assistant.gif_frames, []):
            src = url.lstrip('/').split('?')[0]
            dst = keyed_url(url, version).lstrip('/').split('?')[0]
            if os.path.exists(src):
                _key_file(src, dst, params)
        for slot in ('idle', 'talk'):
            url = getattr(assistant, f'gif_{slot}_url')
            chroma[f'{slot}_key'] = None
            if url and os.path.exists(url.lstrip('/')):
                src = url.lstrip('/')
                folder = os.path.dirname(src)
                for old in os.listdir(folder):
                    if old.startswith(f'key_{slot}_'):
                        try:
                            os.remove(os.path.join(folder, old))
                        except OSError:
                            pass
                dst = os.path.join(folder, f'key_{slot}_{version}.png')
                _key_file(src, dst, params)
                chroma[f'{slot}_key'] = '/' + dst.replace(os.sep, '/')
    except Exception as e:
        print(f'!!! Ошибка хромакея: {e}')
        return f'Не удалось обработать кадры: {e}'
    chroma['version'] = version
    assistant.gif_chroma = json.dumps(chroma)
    return None


@app.route('/assistant/<int:assistant_id>/gif/chroma', methods=['POST'])
@admin_required
def apply_gif_chroma(assistant_id):
    """Хромакей для всех кадров GIF и для картинок «молчит / говорит»."""
    assistant = db.get_or_404(Assistant, assistant_id)
    data = request.get_json(silent=True) or {}
    chroma = _json_or(assistant.gif_chroma, {})
    color_hex = (data.get('color') or chroma.get('color') or '#00ff00').lstrip('#')
    try:
        color = tuple(int(color_hex[i:i + 2], 16) for i in (0, 2, 4))
    except ValueError:
        return jsonify({'error': 'Неверный цвет'}), 400
    chroma.update({
        'enabled': bool(data.get('enabled', True)),
        'color': '#' + color_hex.lower(),
        'tolerance': float(data.get('tolerance', chroma.get('tolerance', 25))),
        'softness': float(data.get('softness', chroma.get('softness', 10))),
        'despill': bool(data.get('despill', chroma.get('despill', True))),
    })
    if chroma['enabled']:
        err = run_chroma(assistant, chroma)
        if err:
            return jsonify({'error': err}), 500
    assistant.gif_chroma = json.dumps(chroma)
    db.session.commit()
    return jsonify({'success': True, **avatar_payload(assistant)})


@app.route('/assistant/<int:assistant_id>/gif/reverse', methods=['POST'])
@admin_required
def reverse_gif_frames(assistant_id):
    """Если в GIF рот открыт в начале, а закрыт в конце — разворачиваем порядок кадров."""
    assistant = db.get_or_404(Assistant, assistant_id)
    frames = []
    try:
        frames = json.loads(assistant.gif_frames or '[]')
    except ValueError:
        frames = []
    assistant.gif_frames = json.dumps(list(reversed(frames)))
    n = len(frames)
    assistant.gif_disabled = json.dumps(sorted(n - 1 - i for i in _json_or(assistant.gif_disabled, []) if 0 <= i < n))
    db.session.commit()
    return jsonify({'success': True, **avatar_payload(assistant)})


@app.route('/preview/<int:assistant_id>')
@admin_required
def widget_preview(assistant_id):
    """Страница-макет сайта для живого предпросмотра виджета в редакторе."""
    assistant = db.get_or_404(Assistant, assistant_id)
    return render_template('widget_preview.html', assistant=assistant, server_url=request.host_url.rstrip('/'))


@app.route('/assistant/<int:assistant_id>/gif/frames', methods=['POST'])
@admin_required
def save_client_gif_frames(assistant_id):
    """Запасной путь: браузер сам разложил GIF на кадры (если на сервере нет Pillow)."""
    assistant = db.get_or_404(Assistant, assistant_id)
    folder = os.path.join(app.config['GIF_FOLDER'], str(assistant.id))
    os.makedirs(folder, exist_ok=True)
    urls = []
    for i, f in enumerate(request.files.getlist('frames')[:64]):
        name = f'frame_{i:03d}.png'
        f.save(os.path.join(folder, name))
        urls.append(f'/static/gif_avatars/{assistant.id}/{name}')
    assistant.gif_frames = json.dumps(urls)
    assistant.gif_disabled = None
    chroma = _json_or(assistant.gif_chroma, {})
    if chroma.get('enabled'):
        run_chroma(assistant, chroma)
    db.session.commit()
    return jsonify({'success': True, **avatar_payload(assistant)})


# ---------- API виджета: оператор ----------

@app.route('/api/widget/handoff', methods=['POST', 'OPTIONS'])
def api_widget_handoff():
    if request.method == 'OPTIONS':
        return _with_cors(jsonify({'ok': True}))
    data = request.get_json(silent=True) or {}
    try:
        chat = _resolve_bridge_chat(assistant_id=data.get('assistant_id'), external_session_id=data.get('session_id'))
    except ValueError as err:
        return _with_cors(jsonify({'error': str(err)})), 400
    target = 'ai' if data.get('cancel') else 'waiting'
    if target == 'waiting' and chat.status == 'operator':
        target = 'operator'
    _set_chat_status(chat, target)
    db.session.commit()
    last = Message.query.filter_by(chat_id=chat.id).order_by(Message.id.desc()).first()
    return _with_cors(jsonify({'success': True, 'status': chat.status, 'chat_id': chat.id, 'last_id': last.id if last else 0}))


_TTS_CACHE = {}


def get_tts_model(rel_path):
    path = _resolve_file_path(rel_path)
    if not path or not os.path.exists(path):
        return None
    if path not in _TTS_CACHE:
        m = torch.package.PackageImporter(path).load_pickle("tts_models", "model")
        m.to(device)
        _TTS_CACHE[path] = m
    return _TTS_CACHE[path]


@app.route('/api/widget/speak', methods=['POST', 'OPTIONS'])
def api_widget_speak():
    """Озвучить произвольную фразу голосом ассистента (для LW.say на сайте)."""
    if request.method == 'OPTIONS':
        return _with_cors(jsonify({'ok': True}))
    data = request.get_json(silent=True) or {}
    assistant = db.session.get(Assistant, data.get('assistant_id') or 0)
    text = prepare_text_for_tts((data.get('text') or '')[:400])
    if not assistant or not text:
        return _with_cors(jsonify({'audio_url': ''}))
    try:
        model = get_tts_model(assistant.tts_model_path)
        if not model:
            return _with_cors(jsonify({'audio_url': ''}))
        os.makedirs(os.path.join('static', 'tts_cache'), exist_ok=True)
        rel = os.path.join('static', 'tts_cache', f'say_{assistant.id}.wav')
        audio = model.apply_tts(text=text, speaker=assistant.tts_speaker, sample_rate=config.SILERO_SAMPLE_RATE)
        torchaudio.save(rel, audio.unsqueeze(0).cpu(), config.SILERO_SAMPLE_RATE)
        return _with_cors(jsonify({'audio_url': '/' + rel.replace(os.sep, '/') + f'?v={uuid.uuid4().hex[:8]}'}))
    except Exception as e:
        print(f"!!! TTS error in widget speak: {e}")
        return _with_cors(jsonify({'audio_url': ''}))


@app.route('/api/widget/history')
def api_widget_history():
    assistant_id = request.args.get('assistant_id', type=int)
    session_id = request.args.get('session_id')
    chat = Chat.query.filter_by(name=f"Bridge session {session_id}", assistant_id=assistant_id).first() if session_id else None
    if not chat:
        return _with_cors(jsonify({'status': 'ai', 'messages': [], 'last_id': 0}))
    msgs = Message.query.filter(Message.chat_id == chat.id).order_by(Message.id.desc()).limit(40).all()
    msgs.reverse()
    return _with_cors(jsonify({
        'status': chat.status or 'ai',
        'messages': [serialize_message(m) for m in msgs],
        'last_id': msgs[-1].id if msgs else 0,
    }))


@app.route('/api/widget/poll')
def api_widget_poll():
    assistant_id = request.args.get('assistant_id', type=int)
    session_id = request.args.get('session_id')
    after = request.args.get('after', 0, type=int)
    if not assistant_id or not session_id:
        return _with_cors(jsonify({'error': 'assistant_id and session_id required'})), 400
    chat = Chat.query.filter_by(name=f"Bridge session {session_id}", assistant_id=assistant_id).first()
    if not chat:
        return _with_cors(jsonify({'status': 'ai', 'messages': [], 'last_id': after}))
    msgs = Message.query.filter(Message.chat_id == chat.id, Message.id > after,
                                Message.role.in_(['operator', 'system'])).order_by(Message.id.asc()).all()
    last = Message.query.filter_by(chat_id=chat.id).order_by(Message.id.desc()).first()
    return _with_cors(jsonify({
        'status': chat.status or 'ai',
        'messages': [serialize_message(m) for m in msgs],
        'last_id': last.id if last else after,
    }))



def init_database():
    os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)
    os.makedirs("temp_audio", exist_ok=True)
    global active_assistant_id
    with app.app_context():
        db.create_all()
        # Миграции: добавляем колонки в существующие таблицы при необходимости
        migrations = [
            ("widget_mode", "ALTER TABLE assistant ADD COLUMN widget_mode VARCHAR(20) DEFAULT 'novel' NOT NULL"),
            ("greeting_phrase", "ALTER TABLE assistant ADD COLUMN greeting_phrase VARCHAR(500) DEFAULT 'Привет! Чем могу помочь? 😊'"),
            ("widget_primary_color", "ALTER TABLE assistant ADD COLUMN widget_primary_color VARCHAR(30) DEFAULT '#667eea'"),
            ("widget_bg_color", "ALTER TABLE assistant ADD COLUMN widget_bg_color VARCHAR(30) DEFAULT 'rgba(15,15,30,0.92)'"),
            ("widget_text_color", "ALTER TABLE assistant ADD COLUMN widget_text_color VARCHAR(30) DEFAULT '#e0e0f0'"),
            ("widget_user_bubble_color", "ALTER TABLE assistant ADD COLUMN widget_user_bubble_color VARCHAR(30) DEFAULT '#667eea'"),
            ("model_name", "ALTER TABLE assistant ADD COLUMN model_name VARCHAR(100) DEFAULT NULL"),
            ("avatar_type", "ALTER TABLE assistant ADD COLUMN avatar_type VARCHAR(20) DEFAULT 'live2d'"),
            ("gif_mode", "ALTER TABLE assistant ADD COLUMN gif_mode VARCHAR(20) DEFAULT 'frames'"),
            ("gif_source_url", "ALTER TABLE assistant ADD COLUMN gif_source_url VARCHAR(300)"),
            ("gif_frames", "ALTER TABLE assistant ADD COLUMN gif_frames TEXT"),
            ("gif_idle_url", "ALTER TABLE assistant ADD COLUMN gif_idle_url VARCHAR(300)"),
            ("gif_talk_url", "ALTER TABLE assistant ADD COLUMN gif_talk_url VARCHAR(300)"),
            ("gif_scale", "ALTER TABLE assistant ADD COLUMN gif_scale FLOAT DEFAULT 1.0"),
            ("gif_offset_y", "ALTER TABLE assistant ADD COLUMN gif_offset_y INTEGER DEFAULT 0"),
            ("gif_noise_floor", "ALTER TABLE assistant ADD COLUMN gif_noise_floor FLOAT DEFAULT 0.008"),
            ("widget_layout", "ALTER TABLE assistant ADD COLUMN widget_layout TEXT"),
            ("gif_disabled", "ALTER TABLE assistant ADD COLUMN gif_disabled TEXT"),
            ("model3d", "ALTER TABLE assistant ADD COLUMN model3d TEXT"),
            ("gif_chroma", "ALTER TABLE assistant ADD COLUMN gif_chroma TEXT"),
            ("gif_smoothing", "ALTER TABLE assistant ADD COLUMN gif_smoothing FLOAT DEFAULT 0.35"),
            ("gif_breathing", "ALTER TABLE assistant ADD COLUMN gif_breathing BOOLEAN DEFAULT 1"),
            ("chat.status", "ALTER TABLE chat ADD COLUMN status VARCHAR(20) DEFAULT 'ai'"),
            ("chat.source", "ALTER TABLE chat ADD COLUMN source VARCHAR(20) DEFAULT 'studio'"),
            ("chat.created_at", "ALTER TABLE chat ADD COLUMN created_at DATETIME"),
            ("chat.operator_seen_id", "ALTER TABLE chat ADD COLUMN operator_seen_id INTEGER DEFAULT 0"),
            ("user.avatar_url", "ALTER TABLE user ADD COLUMN avatar_url VARCHAR(300)"),
            ("user.email", "ALTER TABLE user ADD COLUMN email VARCHAR(200) DEFAULT 'admin@live2d.assistant'"),
            ("user.company", "ALTER TABLE user ADD COLUMN company VARCHAR(200) DEFAULT 'Live2D Assistant'"),
        ]
        for col_name, sql in migrations:
            try:
                db.session.execute(db.text(sql))
                db.session.commit()
                print(f"[DB] Добавлена колонка {col_name}")
            except Exception:
                db.session.rollback()

        # Источник для старых чатов
        try:
            db.session.execute(db.text("UPDATE chat SET source='widget' WHERE name LIKE 'Bridge%' AND (source IS NULL OR source='studio')"))
            db.session.execute(db.text("UPDATE chat SET status='ai' WHERE status IS NULL"))
            db.session.execute(db.text("UPDATE assistant SET avatar_type='live2d' WHERE avatar_type IS NULL"))
            db.session.commit()
        except Exception:
            db.session.rollback()
        os.makedirs(app.config['GIF_FOLDER'], exist_ok=True)
        os.makedirs(app.config['USER_AVATAR_FOLDER'], exist_ok=True)
        os.makedirs(MODELS3D_DIR, exist_ok=True)

        # Аюми получила скелет и мимику: один раз переключаем её на ayumi_rigged.glb
        rig_marker = os.path.join(MODELS3D_DIR, '.rigged_switched')
        if os.path.exists(os.path.join(MODELS3D_DIR, 'ayumi_rigged.glb')) and not os.path.exists(rig_marker):
            for a in Assistant.query.filter(Assistant.avatar_type == '3d').all():
                m3 = _json_or(a.model3d, {})
                if m3.get('url', '').endswith('anime_school_girl.glb'):
                    m3.update({'url': '/static/models3d/ayumi_rigged.glb', 'rotate_y': 0})
                    a.model3d = json.dumps(m3)
            db.session.commit()
            with open(rig_marker, 'w') as fh:
                fh.write('1')

        # Демо-ассистент с 3D-моделью (создаётся один раз, если в static/models3d есть .glb)
        marker = os.path.join(MODELS3D_DIR, '.demo_created')
        models3d = list_models3d()
        if models3d and not os.path.exists(marker):
            demo = Assistant(
                name='Аюми 3D', description='Демо 3D-аватара: модель .glb, бета-версия',
                system_prompt=load_default_system_prompt().replace('Лила', 'Аюми'),
                avatar_type='3d', widget_mode='card',
                photo_url='Live2d_Avatars/ayumi3d.png' if os.path.exists(os.path.join('static', 'Live2d_Avatars', 'ayumi3d.png')) else 'Img/default_avatar.png',
                tts_model_path='static/silero_models/v4_ru.pt', tts_speaker='xenia',
                greeting_phrase='Привет! Я Аюми — трёхмерная помощница. Покрути меня мышкой!',
                model3d=json.dumps({'url': next((m['path'] for m in models3d if 'rigged' in m['path']), models3d[0]['path']), 'scale': 1.0, 'offset_y': 0, 'rotate_y': 0, 'follow': True}),
            )
            db.session.add(demo)
            db.session.commit()
            with open(marker, 'w') as fh:
                fh.write(str(demo.id))
            print(f"[DB] Создан демо 3D-ассистент «{demo.name}»")

        # Инициализируем настройки приложения
        get_ai_settings()

        if not User.query.first():
            db.session.add(User())
            db.session.commit()

        if not Assistant.query.first():
            first_live2d_model_path = ""
            live2d_models_dir = os.path.join('static', 'Live2d_Models')
            if os.path.exists(live2d_models_dir):
                for folder_name in os.listdir(live2d_models_dir):
                    if os.path.isdir(os.path.join(live2d_models_dir, folder_name)):
                        for file in os.listdir(os.path.join(live2d_models_dir, folder_name)):
                            if file.endswith('.model3.json'):
                                first_live2d_model_path = f'/static/Live2d_Models/{folder_name}/{file}'
                                break
                    if first_live2d_model_path:
                        break

            default_prompt = load_default_system_prompt()
            default_assistant = Assistant(
                name='Лила', 
                description='Стандартный ассистент.', 
                system_prompt=default_prompt, 
                live2d_model_path=first_live2d_model_path, 
                tts_model_path='static/silero_models/v4_ru.pt', 
                tts_speaker='kseniya',
                model_name='deepseek-v4-flash'
            )
            db.session.add(default_assistant)
            db.session.commit()
        
        active_assistant = Assistant.query.first()
        if active_assistant:
            active_assistant_id = active_assistant.id

        if not Chat.query.first() and active_assistant:
            default_chat = Chat(name=f"Чат с {active_assistant.name}", assistant_id=active_assistant.id)
            db.session.add(default_chat)
            db.session.commit()
        print("База данных готова к работе.")


def open_browser():
    webbrowser.open_new("http://127.0.0.1:5000")


def bootstrap_models(load_whisper=True):
    global whisper_model, active_silero_model
    init_database()
    print("Загрузка моделей...")

    enable_stt = getattr(config, 'ENABLE_STT', True)
    if enable_stt and load_whisper and whisper_model is None:
        try:
            whisper_model = whisper.load_model("tiny")
            print(">>> Модель Whisper (STT) успешно загружена.")
        except Exception as e:
            print(f"!!! Предупреждение: не удалось загрузить Whisper ({e}). STT отключен.")
            whisper_model = None

    enable_tts = getattr(config, 'ENABLE_TTS', True)
    if enable_tts:
        try:
            with app.app_context():
                active_assistant = db.session.get(Assistant, active_assistant_id) if active_assistant_id else None
            tts_file = _resolve_file_path(active_assistant.tts_model_path) if active_assistant else ""
            if tts_file and os.path.exists(tts_file):
                active_silero_model = torch.package.PackageImporter(tts_file).load_pickle("tts_models", "model")
                active_silero_model.to(device)
                print(f">>> Активная модель голоса '{os.path.basename(active_assistant.tts_model_path)}' ({active_assistant.tts_speaker}) успешно загружена.")
            else:
                print("!!! ВНИМАНИЕ: Не удалось найти файл активной модели голоса (TTS пропущен).")
        except Exception as e:
            print(f"!!! ОШИБКА: Не удалось загрузить модель Silero: {e}")
            active_silero_model = None
    else:
        print(">>> Синтез речи Silero отключен в настройках (ENABLE_TTS = False).")
        active_silero_model = None

    print("Все модели инициализированы!")


if __name__ == '__main__':
    bootstrap_models(load_whisper=True)
    Timer(1, open_browser).start()
    app.run(debug=True, port=5000, use_reloader=False)
