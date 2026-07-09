from fastapi import FastAPI
from fastapi.middleware.wsgi import WSGIMiddleware

from app import app as flask_app, bootstrap_models

api = FastAPI(title="Live2D Assistant Python Server")
api.mount("/", WSGIMiddleware(flask_app))


@api.on_event("startup")
def startup_event():
    bootstrap_models(load_whisper=True)
