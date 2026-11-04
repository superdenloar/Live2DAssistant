import os
import sys
import signal
import numpy as np
import sounddevice as sd
from PyQt5.QtWidgets import QApplication, QLabel, QWidget
from PyQt5.QtCore import Qt, QTimer, QPoint
from PyQt5.QtGui import QMovie

# ================= НАСТРОЙКИ =================
NOISE_FLOOR = 0.008        # Порог тишины (отсекает фоновый шум кулера/микрофона)
INITIAL_MAX_VOL = 0.03     # Стартовый потолок громкости (автоматически растет, когда вы говорите громче)
SMOOTHING = 0.35           # Плавность смены кадров (от 0.1 — очень плавно, до 0.9 — очень резко)
INITIAL_SCALE = 1.0        # Начальный масштаб аватара (1.0 = оригинальный размер)
SHOW_INFO = True           # Показывать ли текущий кадр и громкость в окне cmd
# =============================================

# Мгновенное закрытие по Ctrl+C в cmd
signal.signal(signal.SIGINT, signal.SIG_DFL)


class GifVTuber(QWidget):
    def __init__(self):
        super().__init__()

        base_dir = os.path.dirname(os.path.abspath(__file__))
        self.gif_path = os.path.join(base_dir, "anime.gif")

        if not os.path.exists(self.gif_path):
            print("[Ошибка] Файл anime.gif не найден в папке со скриптом!")
            sys.exit(1)

        # Загружаем все кадры из GIF
        self.orig_frames = self.load_gif_frames(self.gif_path)
        self.total_frames = len(self.orig_frames)

        if self.total_frames == 0:
            print("[Ошибка] Не удалось прочитать кадры из anime.gif!")
            sys.exit(1)

        print(f"Успешно загружено кадров из anime.gif: {self.total_frames}")

        self.scale = INITIAL_SCALE
        self.scaled_frames = []
        self.current_frame_idx = 0

        # Переменные звука
        self.raw_volume = 0.0
        self.smoothed_volume = 0.0
        self.max_volume = INITIAL_MAX_VOL

        self.drag_pos = QPoint()

        self.init_ui()
        self.start_audio()

    def load_gif_frames(self, path):
        """Извлекает все кадры анимации из GIF в список QPixmap."""
        movie = QMovie(path)
        movie.setCacheMode(QMovie.CacheAll)
        frames = []

        # Запускаем и сразу ставим на паузу, чтобы инициализировать декодер
        movie.start()
        movie.setPaused(True)

        count = movie.frameCount()
        if count > 0:
            for i in range(count):
                movie.jumpToFrame(i)
                frames.append(movie.currentPixmap().copy())
        else:
            # На случай если в заголовке GIF не указано число кадров
            movie.jumpToFrame(0)
            while True:
                frames.append(movie.currentPixmap().copy())
                if not movie.jumpToNextFrame() or movie.currentFrameNumber() == 0:
                    break

        movie.stop()
        return frames

    def init_ui(self):
        self.setWindowFlags(
            Qt.FramelessWindowHint |
            Qt.WindowStaysOnTopHint |
            Qt.Tool
        )
        self.setAttribute(Qt.WA_TranslucentBackground)

        self.label = QLabel(self)
        self.update_scaled_frames()

        # Обновление 60 раз в секунду
        self.timer = QTimer(self)
        self.timer.timeout.connect(self.update_state)
        self.timer.start(16)

        self.show()

    def update_scaled_frames(self):
        """Масштабирует все кадры заранее, чтобы переключение не нагружало процессор."""
        base_w = self.orig_frames[0].width()
        base_h = self.orig_frames[0].height()
        w = max(10, int(base_w * self.scale))
        h = max(10, int(base_h * self.scale))

        self.scaled_frames = [
            frame.scaled(w, h, Qt.KeepAspectRatio, Qt.SmoothTransformation)
            for frame in self.orig_frames
        ]

        self.resize(self.scaled_frames[0].width(), self.scaled_frames[0].height())
        self.label.resize(self.scaled_frames[0].width(), self.scaled_frames[0].height())
        self.label.setPixmap(self.scaled_frames[self.current_frame_idx])

    def audio_callback(self, indata, frames, time_info, status):
        # Вычисляем текущую громкость (RMS)
        self.raw_volume = float(np.sqrt(np.mean(indata ** 2)))

    def start_audio(self):
        try:
            self.stream = sd.InputStream(
                callback=self.audio_callback,
                channels=1,
                samplerate=44100,
                blocksize=512
            )
            self.stream.start()
        except Exception as e:
            print(f"[Ошибка микрофона] {e}")
            sys.exit(1)

    def update_state(self):
        # Сглаживаем громкость, чтобы анимация рта была плавной, а не рваной
        if self.raw_volume > self.smoothed_volume:
            # Рот открывается быстро
            self.smoothed_volume = (
                self.smoothed_volume + (self.raw_volume - self.smoothed_volume) * min(1.0, SMOOTHING * 1.5)
            )
        else:
            # Рот закрывается плавно
            self.smoothed_volume = (
                self.smoothed_volume + (self.raw_volume - self.smoothed_volume) * SMOOTHING
            )

        # Если звук громче шума и выше прежнего рекорда — обновляем максимум
        if self.smoothed_volume > self.max_volume and self.smoothed_volume > NOISE_FLOOR:
            self.max_volume = self.smoothed_volume

        # Вычисляем нужный кадр от 0 до (total_frames - 1)
        if self.smoothed_volume <= NOISE_FLOOR:
            target_frame = 0
        else:
            # Доля громкости от 0.0 до 1.0 между порогом тишины и самым громким звуком
            denom = max(0.0001, self.max_volume - NOISE_FLOOR)
            ratio = (self.smoothed_volume - NOISE_FLOOR) / denom
            ratio = max(0.0, min(1.0, ratio))

            # Переводим долю громкости в номер кадра
            target_frame = int(round(ratio * (self.total_frames - 1)))

        if target_frame != self.current_frame_idx:
            self.current_frame_idx = target_frame
            self.label.setPixmap(self.scaled_frames[self.current_frame_idx])

        if SHOW_INFO:
            print(
                f"Кадр: {self.current_frame_idx + 1:2d}/{self.total_frames} | "
                f"Громкость: {self.smoothed_volume:.4f} | "
                f"Максимум: {self.max_volume:.4f}   ",
                end="\r"
            )

    # --- Управление мышью ---
    def mousePressEvent(self, event):
        if event.button() == Qt.LeftButton:
            self.drag_pos = event.globalPos() - self.frameGeometry().topLeft()
            event.accept()
        elif event.button() == Qt.RightButton:
            # Сброс максимальной громкости по правому клику
            self.max_volume = INITIAL_MAX_VOL
            print("\n[Инфо] Максимальная громкость сброшена! Калибруем заново.")
            event.accept()

    def mouseMoveEvent(self, event):
        if event.buttons() == Qt.LeftButton:
            self.move(event.globalPos() - self.drag_pos)
            event.accept()

    def wheelEvent(self, event):
        delta = event.angleDelta().y()
        if delta > 0:
            self.scale = min(3.0, self.scale + 0.05)
        else:
            self.scale = max(0.1, self.scale - 0.05)
        self.update_scaled_frames()


if __name__ == "__main__":
    print("=== GIF-VTuber запущен ===")
    print("- ЛКМ (зажать): переместить аватар")
    print("- Колесико мыши: изменить размер")
    print("- ПКМ (правый клик по аватару): сбросить рекорд максимальной громкости")
    print("- Закрыть это окно cmd или нажать Ctrl+C: выключить аватар\n")

    app = QApplication(sys.argv)
    vtuber = GifVTuber()
    sys.exit(app.exec_())