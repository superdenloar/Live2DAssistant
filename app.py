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
import re # Импорт для работы с регулярными выражениями

from flask import Flask, render_template, request, jsonify, redirect, url_for
from flask_sqlalchemy import SQLAlchemy
from openai import OpenAI
import whisper
import torchaudio

# === ОБНОВЛЕННЫЙ СЛОВАРЬ КОМАНД ===
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
db = SQLAlchemy(app)

# --- Добавляем FFmpeg в PATH ---
project_dir = os.path.dirname(os.path.abspath(__file__)) 
ffmpeg_dir = os.path.join(project_dir, "ffmpeg")
if os.path.isdir(ffmpeg_dir):
    os.environ["PATH"] = ffmpeg_dir + os.pathsep + os.environ["PATH"]

# --- ОПИСАНИЕ МОДЕЛЕЙ БАЗЫ ДАННЫХ ---
class User(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(80), default='Пользователь')
    description = db.Column(db.String(300), default='Описание для ассистентов...')

class Assistant(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(80), nullable=False)
    description = db.Column(db.String(300))
    photo_url = db.Column(db.String(200), default='Img/default_avatar.png')
    system_prompt = db.Column(db.Text, nullable=False)
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
    widget_mode = db.Column(db.String(20), default='novel', nullable=False)  # 'popup' или 'novel'
    greeting_phrase = db.Column(db.String(500), default='Привет! Чем могу помочь? 😊')
    widget_primary_color = db.Column(db.String(30), default='#667eea')   # основной цвет (кнопки, акценты)
    widget_bg_color = db.Column(db.String(30), default='rgba(15,15,30,0.92)')  # фон панели
    widget_text_color = db.Column(db.String(30), default='#e0e0f0')      # цвет текста
    widget_user_bubble_color = db.Column(db.String(30), default='#667eea')  # цвет пузырей пользователя
    boredom_phrases = db.relationship('BoredomPhrase', backref='assistant', lazy=True, cascade="all, delete-orphan")
    chats = db.relationship('Chat', backref='assistant', lazy=True, cascade="all, delete-orphan")

class Chat(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(120), nullable=False)
    assistant_id = db.Column(db.Integer, db.ForeignKey('assistant.id'), nullable=False)
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
client = OpenAI(base_url=config.LM_STUDIO_URL, api_key="not-needed")
whisper_model = None
active_silero_model = None
active_assistant_id = None


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
    Если чат не найден, создаёт его автоматически.
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

    new_chat = Chat(name=chat_name, assistant_id=resolved_assistant.id)
    db.session.add(new_chat)
    db.session.commit()
    return new_chat

@app.route('/')
def index():
    user_profile = User.query.first()
    assistants = Assistant.query.all()
    chats = Chat.query.order_by(Chat.id.desc()).all()
    
    active_assistant = db.session.get(Assistant, active_assistant_id) if active_assistant_id else None
    if not active_assistant and chats:
        active_assistant = chats[0].assistant
    elif not active_assistant and assistants:
        active_assistant = assistants[0]

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
        "boredom_max_time": active_assistant.boredom_max_time if active_assistant else 120
    }
    
    return render_template('index.html', config_data=frontend_config, user=user_profile, assistants=assistants, chats=chats)

@app.route('/chat/<int:chat_id>/load')
def load_chat(chat_id):
    global active_silero_model, active_assistant_id
    
    print(f"\n[DEBUG] Поступил запрос на загрузку чата с ID: {chat_id}")
    
    chat = db.get_or_404(Chat, chat_id)
    active_assistant_id = chat.assistant_id
    assistant = chat.assistant
    
    # === ГЛАВНОЕ ИЗМЕНЕНИЕ: Более надежный способ получения сообщений ===
    # Мы явно запрашиваем сообщения, связанные с этим chat_id, и сортируем их по времени.
    messages_from_db = Message.query.filter_by(chat_id=chat_id).order_by(Message.timestamp).all()
    
    # Преобразуем их в формат для JSON
    messages = [{"id": msg.id, "role": msg.role, "content": msg.content, "audio_url": msg.audio_url} for msg in messages_from_db]
    
    print(f"[DEBUG] Найдено и обработано сообщений в чате: {len(messages)}")

    try:
        if assistant and os.path.exists(assistant.tts_model_path):
            active_silero_model = torch.package.PackageImporter(assistant.tts_model_path).load_pickle("tts_models", "model")
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
            "boredom_use_llm": assistant.boredom_use_llm 
        }
    }
    
    print(f"[DEBUG] Отправка JSON на фронтенд...")
    return jsonify(data_to_send)

@app.route('/chat/create', methods=['POST'])
def create_chat():
    name = request.form.get('chat_name')
    assistant_id = request.form.get('assistant_id', type=int)
    if name and assistant_id:
        new_chat = Chat(name=name, assistant_id=assistant_id)
        db.session.add(new_chat)
        db.session.commit()
    return redirect(url_for('index'))

@app.route('/chat/<int:chat_id>/delete', methods=['POST'])
def delete_chat(chat_id):
    chat_to_delete = db.get_or_404(Chat, chat_id)
    db.session.delete(chat_to_delete)
    db.session.commit()
    return redirect(url_for('index'))

@app.route('/profile/update', methods=['POST'])
def update_profile():
    try:
        # Находим единственного пользователя
        user_profile = User.query.first()
        if not user_profile:
            # На всякий случай, если пользователя нет, создаем его
            user_profile = User()
            db.session.add(user_profile)

        # Получаем данные из формы и обновляем поля
        user_profile.name = request.form.get('name')
        user_profile.description = request.form.get('description')
        
        # Сохраняем изменения в базе данных
        db.session.commit()
        return jsonify({'success': True, 'message': 'Профиль успешно сохранен.'})
    except Exception as e:
        db.session.rollback()
        print(f"!!! ОШИБКА обновления профиля: {e}")
        return jsonify({'success': False, 'message': 'Не удалось сохранить профиль.'}), 500

# --- ФИНАЛЬНАЯ ВЕРСИЯ ФУНКЦИИ CHAT ---

@app.route('/chat', methods=['POST'])
def chat():
    chat_id = request.form.get('chat_id', type=int)
    if not chat_id: return jsonify({"error": "Chat ID is required"}), 400
    
    chat_session = db.get_or_404(Chat, chat_id)
    assistant = chat_session.assistant
    user_message_id, ai_message_id = None, None
    
    try:
        # --- 1. Получаем оригинальное сообщение пользователя ---
        raw_user_input = ""
        user_message_audio_url = None

        if 'audio_blob' in request.files:
            audio_file = request.files['audio_blob']
            filename = f"{uuid.uuid4()}.webm" 
            temp_path = os.path.join("temp_audio", filename)
            audio_file.save(temp_path)
            result = whisper.transcribe(whisper_model, temp_path, fp16=False)
            raw_user_input = result['text'].strip() if result['text'] else "" # Важно: пустая строка, а не "(Тишина)"
            user_message_audio_url = temp_path
        elif 'text' in request.form:
            raw_user_input = request.form.get('text')

        # --- 2. Извлекаем команды пользователя ---
        user_live2d_commands = []
        user_command_matches = re.findall(r'【(.*?)】', raw_user_input)
        if user_command_matches:
            for command_text in user_command_matches:
                system_command = COMMAND_MAP.get(command_text)
                if system_command:
                    user_live2d_commands.append(system_command)
        
        # --- 3. Формируем контекст для LLM ---
        user_profile = User.query.first()
        history_from_db = Message.query.filter_by(chat_id=chat_id).order_by(Message.timestamp.desc()).limit(assistant.memory_depth).all()
        history_from_db.reverse()
        
        user_info_prompt = (
            f"\n\n[Информация о собеседнике, с которым ты общаешься]\n"
            f"Имя: {user_profile.name}\n"
            f"Описание: {user_profile.description}"
        )
        full_system_prompt = assistant.system_prompt + user_info_prompt

        conversation_history = [{"role": "system", "content": full_system_prompt}] + [{"role": msg.role, "content": msg.content} for msg in history_from_db]
        
        # === ГЛАВНОЕ ИСПРАВЛЕНИЕ ЗДЕСЬ ===
        content_for_llm = ""
        is_patting_reaction_sent = False
        
        if request.form.get('patting_reaction') == 'true':
            patting_remark = "*(Ты чувствуешь, что тебя долго и нежно гладили. Можешь отреагировать на это.)*\n\n"
            content_for_llm += patting_remark
            is_patting_reaction_sent = True

        if raw_user_input:
            content_for_llm += raw_user_input

        # Отправляем сообщение в LLM, только если есть что отправлять
        if content_for_llm:
            conversation_history.append({"role": "user", "content": content_for_llm})
        
        # --- 4. Генерация ответа ---
        raw_ai_response = ""
        # Генерируем ответ, только если было реальное сообщение или реакция на поглаживание
        if content_for_llm:
            if config.ENABLE_LM_STUDIO:
                try:
                    completion = client.chat.completions.create( model=config.LM_STUDIO_MODEL, messages=conversation_history, temperature=0.7 )
                    raw_ai_response = completion.choices[0].message.content.strip()
                except Exception as e:
                    print(f"!!! ОШИБКА ПОДКЛЮЧЕНИЯ К LM STUDIO: {e}")
                    raw_ai_response = "Прости, у меня сейчас нет связи с нейросетью. Попробуй позже."
            else:
                raw_ai_response = "Тестовый ответ ассистента."

        # --- 5. Обработка команд и сохранение ---
        ai_live2d_commands = []
        ai_command_matches = re.findall(r'【(.*?)】', raw_ai_response)
        if ai_command_matches:
            for command_text in ai_command_matches:
                system_command = COMMAND_MAP.get(command_text)
                if system_command:
                    ai_live2d_commands.append(system_command)
        
        final_live2d_commands = ai_live2d_commands if ai_live2d_commands else user_live2d_commands

        # Сохраняем в БД только РЕАЛЬНОЕ сообщение пользователя, а не системные заметки
        if raw_user_input:
            user_message = Message(chat_id=chat_id, role='user', content=raw_user_input, audio_url=user_message_audio_url)
            db.session.add(user_message)
        
        if raw_ai_response:
            ai_message = Message(chat_id=chat_id, role='assistant', content=raw_ai_response)
            db.session.add(ai_message)
        
        if raw_user_input or raw_ai_response:
            db.session.commit()
            if 'user_message' in locals(): user_message_id = user_message.id
            if 'ai_message' in locals(): ai_message_id = ai_message.id

        # --- 6. Синтез речи ---
        audio_url = ""
        text_for_tts = re.sub(r'【.*?】', '', raw_ai_response).strip()
        if active_silero_model and text_for_tts:
            output_wav_path = f"static/response.wav"
            audio_tensor = active_silero_model.apply_tts(text=text_for_tts, speaker=assistant.tts_speaker, sample_rate=config.SILERO_SAMPLE_RATE)
            torchaudio.save(output_wav_path, audio_tensor.unsqueeze(0).cpu(), config.SILERO_SAMPLE_RATE)
            audio_url = f'/{output_wav_path}?v={uuid.uuid4()}'
            
    except Exception as e:
        db.session.rollback()
        print(f"!!! КРИТИЧЕСКАЯ ОШИБКА в /chat: {e}")
        raw_ai_response = "Произошла серьезная внутренняя ошибка сервера."
        
    return jsonify({
        'user_text': raw_user_input, 
        'ai_text': raw_ai_response,
        'audio_url': audio_url,
        'user_message_id': user_message_id,
        'ai_message_id': ai_message_id,
        'live2d_commands': final_live2d_commands
    })


# --- API ДЛЯ ВИДЖЕТА ---

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
    """Возвращает ПОЛНУЮ конфигурацию ассистента для виджета."""
    assistant = db.get_or_404(Assistant, assistant_id)
    return jsonify({
        'id': assistant.id,
        'name': assistant.name,
        'live2d_model_path': assistant.live2d_model_path,
        'scale': assistant.scale,
        'posX': assistant.pos_x,
        'posY': assistant.pos_y,
        'photo_url': f'/static/{assistant.photo_url}',
        # Patting
        'patting_enabled': assistant.patting_enabled,
        'patting_tilt_angle': assistant.patting_tilt_angle,
        'patting_eye_close': assistant.patting_eye_close,
        'patting_follow_strength': assistant.patting_follow_strength,
        # Boredom
        'boredom_enabled': assistant.boredom_enabled,
        'boredom_min_time': assistant.boredom_min_time,
        'boredom_max_time': assistant.boredom_max_time,
        'boredom_use_llm': assistant.boredom_use_llm,
        # Mouth / lip-sync
        'mouth_min_open': assistant.mouth_min_open,
        'mouth_max_open': assistant.mouth_max_open,
        'mouth_jitter_strength': assistant.mouth_jitter_strength,
        'mouth_jitter_speed': assistant.mouth_jitter_speed,
        # Widget mode
        'widget_mode': assistant.widget_mode or 'novel',
        # Greeting & styling
        'greeting_phrase': assistant.greeting_phrase or 'Привет! Чем могу помочь? 😊',
        'widget_primary_color': assistant.widget_primary_color or '#667eea',
        'widget_bg_color': assistant.widget_bg_color or 'rgba(15,15,30,0.92)',
        'widget_text_color': assistant.widget_text_color or '#e0e0f0',
        'widget_user_bubble_color': assistant.widget_user_bubble_color or '#667eea',
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

        <h2>С контекстом (игровые данные и т.п.)</h2>
        <p>Если вы хотите передавать данные вашего приложения ассистенту:</p>
        <pre><code>&lt;script&gt;
  window.__ASSISTANT_CONTEXT__ = () =&gt; ({{
    score: 42,
    level: 'easy',
    status: 'playing'
  }});
&lt;/script&gt;
&lt;script src="{server_url}/static/widget.js"
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

        <h2>Параметры</h2>
        <div class="card">
            <p><code>data-server</code> — URL основного сервера Live2D Assistant</p>
            <p><code>data-assistant-id</code> — ID ассистента: <span class="id-badge">{assistant.id}</span></p>
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

    try:
        user_profile = User.query.first()
        if not user_profile:
            user_profile = User()
            db.session.add(user_profile)
            db.session.commit()

        history_from_db = Message.query.filter_by(chat_id=chat_id).order_by(Message.timestamp.desc()).limit(assistant.memory_depth).all()
        history_from_db.reverse()

        user_info_prompt = (
            f"\n\n[Информация о собеседнике, с которым ты общаешься]\n"
            f"Имя: {user_profile.name}\n"
            f"Описание: {user_profile.description}"
        )
        full_system_prompt = assistant.system_prompt + user_info_prompt
        conversation_history = [{"role": "system", "content": full_system_prompt}] + [
            {"role": msg.role, "content": msg.content} for msg in history_from_db
        ]

        context_lines = []
        if isinstance(game_context, dict):
            for key, value in game_context.items():
                context_lines.append(f"- {key}: {value}")

        bridge_context = (
            "\n\n[Контекст с внешнего игрового сервера]\n"
            + ("\n".join(context_lines) if context_lines else "- Контекст не передан")
            + "\nИспользуй эти данные как подсказки по текущей партии и объясняй их игроку понятным языком."
        )
        content_for_llm = raw_user_input + bridge_context
        conversation_history.append({"role": "user", "content": content_for_llm})

        if config.ENABLE_LM_STUDIO:
            completion = client.chat.completions.create(
                model=config.LM_STUDIO_MODEL,
                messages=conversation_history,
                temperature=0.7,
            )
            raw_ai_response = completion.choices[0].message.content.strip()
        else:
            raw_ai_response = "Тестовый ответ ассистента для внешнего сервера."

        user_message = Message(chat_id=chat_id, role='user', content=raw_user_input)
        ai_message = Message(chat_id=chat_id, role='assistant', content=raw_ai_response)
        db.session.add(user_message)
        db.session.add(ai_message)
        db.session.commit()

        audio_url = ""
        text_for_tts = re.sub(r'【.*?】', '', raw_ai_response).strip()
        if active_silero_model and text_for_tts:
            output_wav_path = 'static/response.wav'
            audio_tensor = active_silero_model.apply_tts(
                text=text_for_tts,
                speaker=assistant.tts_speaker,
                sample_rate=config.SILERO_SAMPLE_RATE,
            )
            torchaudio.save(output_wav_path, audio_tensor.unsqueeze(0).cpu(), config.SILERO_SAMPLE_RATE)
            audio_url = f'/{output_wav_path}?v={uuid.uuid4()}'

        response = jsonify({
            'chat_id': chat_id,
            'assistant_id': assistant.id,
            'user_text': raw_user_input,
            'ai_text': raw_ai_response,
            'audio_url': audio_url,
            'game_context': game_context,
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
    if not assistant.boredom_phrases: return jsonify({"error": "No phrases available"}), 404
    phrase = random.choice(assistant.boredom_phrases)
    try:
        if active_silero_model:
            output_wav_path = f"static/response.wav"
            audio_tensor = active_silero_model.apply_tts(text=phrase.text, speaker=assistant.tts_speaker, sample_rate=config.SILERO_SAMPLE_RATE)
            torchaudio.save(output_wav_path, audio_tensor.unsqueeze(0).cpu(), config.SILERO_SAMPLE_RATE)
            audio_url = f'/{output_wav_path}?v={uuid.uuid4()}'
            return jsonify({"text": phrase.text, "audio_url": audio_url})
        else: return jsonify({"error": "TTS model not loaded"}), 500
    except Exception as e:
        print(f"!!! ОШИБКА генерации фразы скуки: {e}")
        return jsonify({"error": "TTS failed for boredom phrase"}), 500
    
@app.route('/boredom_phrase/generate', methods=['POST']) # Изменили маршрут и метод
def generate_boredom_phrase():
    # Получаем данные из запроса
    data = request.json
    assistant_id = data.get('assistant_id')
    chat_id = data.get('chat_id')

    if not assistant_id or not chat_id:
        return jsonify({"error": "Assistant ID and Chat ID are required"}), 400

    assistant = db.get_or_404(Assistant, assistant_id)
    
    # --- ГЛАВНОЕ ИЗМЕНЕНИЕ: Загружаем историю чата ---
    history_from_db = Message.query.filter_by(chat_id=chat_id).order_by(Message.timestamp.desc()).limit(assistant.memory_depth).all()
    history_from_db.reverse()

    # Формируем полный контекст, как в основной функции чата
    conversation = [
        {"role": "system", "content": assistant.system_prompt}
    ] + [{"role": msg.role, "content": msg.content} for msg in history_from_db]

    # Добавляем финальную инструкцию для нейросети
    boredom_instruction = (
        "[СИСТЕМНАЯ ИНСТРУКЦИЯ] "
        "Пользователь долго не отвечает. Оставаясь в рамках своей роли и характера, "
        "придумай и скажи одну короткую, живую фразу, чтобы привлечь его внимание. "
        "Ответь только самой фразой, без лишних слов и системных инструкций."
    )
    conversation.append({"role": "user", "content": boredom_instruction})
    
    try:
        completion = client.chat.completions.create(
            model=config.LM_STUDIO_MODEL,
            messages=conversation,
            temperature=0.8
        )
        # Получаем полный сгенерированный текст (с возможными командами)
        generated_text_with_commands = completion.choices[0].message.content.strip()

        # === ДОБАВЬТЕ ЭТИ ДВЕ СТРОЧКИ ===
        # 1. Создаем "чистую" версию текста для озвучки, вырезая команды
        text_for_tts = re.sub(r'【.*?】', '', generated_text_with_commands).strip()
        # 2. Ищем и извлекаем сами команды для отправки на фронтенд (пока не используется, но для будущего)
        # live2d_commands = re.findall(r'【(.*?)】', generated_text_with_commands) 
        # =================================

        # Озвучиваем фразу
        audio_url = ""
        # === ИЗМЕНИТЕ ЭТУ СТРОКУ ===
        # БЫЛО: if active_silero_model and generated_text:
        # СТАЛО: (используем "чистую" версию текста)
        if active_silero_model and text_for_tts:
            output_wav_path = f"static/response.wav"
            # === И ИЗМЕНИТЕ ЭТУ СТРОКУ ===
            # БЫЛО: audio_tensor = active_silero_model.apply_tts(text=generated_text, ...
            # СТАЛО:
            audio_tensor = active_silero_model.apply_tts(text=text_for_tts, speaker=assistant.tts_speaker, sample_rate=config.SILERO_SAMPLE_RATE)
            torchaudio.save(output_wav_path, audio_tensor.unsqueeze(0).cpu(), config.SILERO_SAMPLE_RATE)
            audio_url = f'/{output_wav_path}?v={uuid.uuid4()}'
        
        # === ИЗМЕНИТЕ ЭТУ СТРОКУ ===
        # Возвращаем на фронтенд ПОЛНЫЙ текст (чтобы script.js сам его очистил для отображения)
        # БЫЛО: return jsonify({"text": generated_text, "audio_url": audio_url})
        # СТАЛО:
        return jsonify({"text": generated_text_with_commands, "audio_url": audio_url})

    except Exception as e:
        print(f"!!! ОШИБКА генерации фразы скуки через LLM: {e}")
        # В случае ошибки, вернем простую фразу, чтобы не ломать приложение
        return jsonify({"text": "Эй, ты где?", "audio_url": ""})

@app.route('/message/delete/<int:message_id>', methods=['POST'])
def delete_message(message_id):
    msg = db.get_or_404(Message, message_id)
    if msg.audio_url and os.path.exists(msg.audio_url):
        try: os.remove(msg.audio_url)
        except OSError as e: print(f"Ошибка удаления аудиофайла: {e}")
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
def edit_assistant(assistant_id):
    assistant = db.get_or_404(Assistant, assistant_id)
    live2d_models_dir = os.path.join('static', 'Live2d_Models')
    tts_models_dir = os.path.dirname(config.SILERO_MODEL_PATH)
    live2d_models, tts_models = [], []
    if os.path.exists(live2d_models_dir):
        for folder_name in os.listdir(live2d_models_dir):
            model_folder_path = os.path.join(live2d_models_dir, folder_name)
            if os.path.isdir(model_folder_path):
                for filename in os.listdir(model_folder_path):
                    if filename.endswith('.model3.json'):
                        model_path_for_web = f'/static/Live2d_Models/{folder_name}/{filename}'
                        live2d_models.append({'name': folder_name, 'path': model_path_for_web})
                        break
    if os.path.exists(tts_models_dir):
        tts_models = [f.replace('.pt', '') for f in os.listdir(tts_models_dir) if f.endswith('.pt')]
    current_model_name = os.path.basename(assistant.tts_model_path).replace('.pt', '') if assistant.tts_model_path else (tts_models[0] if tts_models else None)
    current_speakers = MODEL_SPEAKERS.get(current_model_name, [])
    boredom_phrases = assistant.boredom_phrases
    return render_template('edit_assistant.html', assistant=assistant, live2d_models=live2d_models, tts_models=tts_models, current_speakers=current_speakers, all_speakers_json=json.dumps(MODEL_SPEAKERS), boredom_phrases=boredom_phrases)

@app.route('/assistant/add', methods=['GET'])
def add_assistant():
    new_assistant = Assistant(name="Новый ассистент", description="Настройте меня...", system_prompt="Задайте роль...")
    db.session.add(new_assistant)
    db.session.commit()
    return redirect(url_for('edit_assistant', assistant_id=new_assistant.id))

@app.route('/assistant/<int:assistant_id>/update', methods=['POST'])
def update_assistant(assistant_id):
    assistant = db.get_or_404(Assistant, assistant_id)
    
    # Считываем все данные из формы
    assistant.name = request.form.get('name')
    assistant.description = request.form.get('description')
    assistant.system_prompt = request.form.get('system_prompt')
    assistant.live2d_model_path = request.form.get('live2d_model')
    assistant.tts_model_path = f"static/silero_models/{request.form.get('tts_model')}.pt"
    assistant.tts_speaker = request.form.get('tts_speaker')
    assistant.scale = request.form.get('scale', 2.4, type=float)
    assistant.pos_x = request.form.get('pos_x', 0, type=int)
    assistant.pos_y = request.form.get('pos_y', 50, type=int)
    assistant.memory_depth = request.form.get('memory_depth', 10, type=int)
    assistant.mouth_min_open = request.form.get('mouth_min_open', 0.05, type=float)
    assistant.mouth_max_open = request.form.get('mouth_max_open', 0.8, type=float)
    assistant.mouth_jitter_strength = request.form.get('mouth_jitter_strength', 0.05, type=float)
    assistant.mouth_jitter_speed = request.form.get('mouth_jitter_speed', 50.0, type=float)
    
    # Обработка галочек системы интерактивности
    assistant.boredom_enabled = 'boredom_enabled' in request.form
    assistant.patting_enabled = 'patting_enabled' in request.form
    
    assistant.boredom_min_time = request.form.get('boredom_min_time', 30, type=int)
    assistant.boredom_max_time = request.form.get('boredom_max_time', 120, type=int)
    
    assistant.patting_tilt_angle = request.form.get('patting_tilt_angle', 15.0, type=float)
    assistant.patting_eye_close = request.form.get('patting_eye_close', 0.8, type=float)
    assistant.patting_follow_strength = request.form.get('patting_follow_strength', 0.1, type=float)

    assistant.boredom_use_llm = 'boredom_use_llm' in request.form
    assistant.widget_mode = request.form.get('widget_mode', 'novel')
    assistant.greeting_phrase = request.form.get('greeting_phrase', 'Привет! Чем могу помочь? 😊')
    assistant.widget_primary_color = request.form.get('widget_primary_color', '#667eea')
    assistant.widget_bg_color = request.form.get('widget_bg_color', 'rgba(15,15,30,0.92)')
    assistant.widget_text_color = request.form.get('widget_text_color', '#e0e0f0')
    assistant.widget_user_bubble_color = request.form.get('widget_user_bubble_color', '#667eea')

    db.session.commit()
    
    return redirect(url_for('edit_assistant', assistant_id=assistant.id))

@app.route('/assistant/<int:assistant_id>/delete', methods=['POST'])
def delete_assistant(assistant_id):
    assistant = db.get_or_404(Assistant, assistant_id)
    default_avatar_path = 'Img/default_avatar.png'
    if assistant.photo_url != default_avatar_path:
        avatar_to_delete = os.path.join('static', assistant.photo_url)
        if os.path.exists(avatar_to_delete):
            try: os.remove(avatar_to_delete)
            except OSError as e: print(f"!!! ОШИБКА при удалении файла аватара: {e} ---")
    db.session.delete(assistant)
    db.session.commit()
    return redirect(url_for('index'))
    
@app.route('/assistant/<int:assistant_id>/upload_avatar', methods=['POST'])
def upload_avatar(assistant_id):
    assistant = db.get_or_404(Assistant, assistant_id)
    if 'avatar' not in request.files: return jsonify({"error": "No file part"}), 400
    file = request.files['avatar']
    if file.filename == '': return jsonify({"error": "No selected file"}), 400
    if file:
        default_avatar_path = 'Img/default_avatar.png'
        if assistant.photo_url != default_avatar_path:
            old_avatar_path = os.path.join('static', assistant.photo_url)
            if os.path.exists(old_avatar_path): os.remove(old_avatar_path)
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
            try: os.remove(old_avatar_path_os)
            except Exception as e: print(f"!!! ОШИБКА при удалении старого аватара: {e}")
    assistant.photo_url = default_avatar_path_db
    db.session.commit()
    return jsonify({"success": True, "new_photo_url": url_for('static', filename=default_avatar_path_db)})

@app.route('/assistant/test_tts', methods=['POST'])
def test_tts():
    data = request.json
    text_to_speak = data.get('text')
    tts_model_name = data.get('model_name')
    tts_speaker_name = data.get('speaker_name')
    if not all([text_to_speak, tts_model_name, tts_speaker_name]):
        return jsonify({"error": "Missing data"}), 400
    try:
        tts_model_path = os.path.join('static', 'silero_models', f'{tts_model_name}.pt')
        if not os.path.exists(tts_model_path): return jsonify({"error": "Model file not found"}), 404
        test_model = torch.package.PackageImporter(tts_model_path).load_pickle("tts_models", "model")
        test_model.to(device)
        output_wav_path = os.path.join("static", "temp_test_speech.wav")
        audio_tensor = test_model.apply_tts(text=text_to_speak, speaker=tts_speaker_name, sample_rate=config.SILERO_SAMPLE_RATE)
        torchaudio.save(output_wav_path, audio_tensor.unsqueeze(0).cpu(), config.SILERO_SAMPLE_RATE)
        audio_url = f'/{output_wav_path}?v={uuid.uuid4()}'
        return jsonify({"audio_url": audio_url})
    except Exception as e:
        print(f"!!! ОШИБКА ТЕСТИРОВАНИЯ TTS: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/assistant/boredom/add/<int:assistant_id>', methods=['POST'])
def add_boredom_phrase(assistant_id):
    text = request.json.get('text')
    if not text: return jsonify({'error': 'Text is required'}), 400
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

def init_database():
    os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)
    os.makedirs("temp_audio", exist_ok=True)
    global active_assistant_id
    with app.app_context():
        db.create_all()
        # Миграция: добавляем новые колонки если нет
        migrations = [
            ("widget_mode", "ALTER TABLE assistant ADD COLUMN widget_mode VARCHAR(20) DEFAULT 'novel' NOT NULL"),
            ("greeting_phrase", "ALTER TABLE assistant ADD COLUMN greeting_phrase VARCHAR(500) DEFAULT 'Привет! Чем могу помочь? 😊'"),
            ("widget_primary_color", "ALTER TABLE assistant ADD COLUMN widget_primary_color VARCHAR(30) DEFAULT '#667eea'"),
            ("widget_bg_color", "ALTER TABLE assistant ADD COLUMN widget_bg_color VARCHAR(30) DEFAULT 'rgba(15,15,30,0.92)'"),
            ("widget_text_color", "ALTER TABLE assistant ADD COLUMN widget_text_color VARCHAR(30) DEFAULT '#e0e0f0'"),
            ("widget_user_bubble_color", "ALTER TABLE assistant ADD COLUMN widget_user_bubble_color VARCHAR(30) DEFAULT '#667eea'"),
        ]
        for col_name, sql in migrations:
            try:
                db.session.execute(db.text(sql))
                db.session.commit()
                print(f"[DB] Добавлена колонка {col_name}")
            except Exception:
                db.session.rollback()
        if not User.query.first(): db.session.add(User()); db.session.commit()
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
            default_assistant = Assistant(name='Лила', description='Стандартный ассистент.', system_prompt='Ты — аниме-девушка по имени Лила.', live2d_model_path=first_live2d_model_path, tts_model_path=f'static/silero_models/v4_ru.pt', tts_speaker='kseniya')
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

    if load_whisper and whisper_model is None:
        whisper_model = whisper.load_model("tiny")

    try:
        active_assistant = db.session.get(Assistant, active_assistant_id) if active_assistant_id else None
        if active_assistant and os.path.exists(active_assistant.tts_model_path):
            active_silero_model = torch.package.PackageImporter(active_assistant.tts_model_path).load_pickle("tts_models", "model")
            active_silero_model.to(device)
            print(f">>> Активная модель голоса '{os.path.basename(active_assistant.tts_model_path)}' ({active_assistant.tts_speaker}) успешно загружена.")
        else:
            print("!!! ВНИМАНИЕ: Не удалось загрузить активную модель голоса.")
    except Exception as e:
        print(f"!!! ОШИБКА: Не удалось загрузить модель Silero: {e}")

    print("Все модели успешно загружены!")


if __name__ == '__main__':
    bootstrap_models(load_whisper=True)
    Timer(1, open_browser).start()
    app.run(debug=True, port=5000, use_reloader=False)
