from fastapi import APIRouter
from app.scheduler import scheduler

def get_router() -> APIRouter:
    router = APIRouter()

    @router.get("/jobs")
    def list_jobs():
        return {"jobs": scheduler.list_jobs()}

    return router