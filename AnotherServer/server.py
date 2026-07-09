"""
AnotherServer — Standalone Checkers Game Server.
Порт 8080. Раздаёт статику из ./static/
"""
import http.server
import socketserver
import os

PORT = 8080
DIRECTORY = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'static')


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        super().end_headers()


if __name__ == '__main__':
    with socketserver.TCPServer(('', PORT), Handler) as httpd:
        print(f'=== AnotherServer (Шашки) запущен на http://127.0.0.1:{PORT} ===')
        print(f'    Раздача файлов из: {DIRECTORY}')
        print(f'    Для остановки нажмите Ctrl+C')
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print('\nСервер остановлен.')
