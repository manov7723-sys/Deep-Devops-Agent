import os
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.vault import load_aws_creds_from_vault
from app.agent import agent
from app.scheduler import scheduler
from app.aws_connector import aws_connector

from app.routers.onboard import get_router as get_onboard_router
from app.routers.chat import get_router as get_chat_router
from app.routers.github import get_router as get_github_router
from app.routers.vault import get_router as get_vault_router
from app.routers.aws import get_router as get_aws_router
from app.routers.config import get_router as get_config_router
from app.routers.terraform import get_router as get_terraform_router
from app.routers.scheduler import get_router as get_scheduler_router
from app.routers.eks import get_router as get_eks_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    print("🚀 DevOps Agent starting...")
    await load_aws_creds_from_vault()
    yield
    print("🛑 Shutting down...")
    scheduler.shutdown()
    await agent.shutdown()


def create_app() -> FastAPI:
    app = FastAPI(
        title="DevOps Agent API",
        version="2.0.0",
        description="AI-powered DevOps automation with AWS & scheduling",
        lifespan=lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(get_onboard_router(),   prefix="/onboard",   tags=["onboard"])
    app.include_router(get_chat_router(),      prefix="/chat",      tags=["chat"])
    app.include_router(get_github_router(),    prefix="",           tags=["github"])
    app.include_router(get_vault_router(),     prefix="/vault",     tags=["vault"])
    app.include_router(get_aws_router(),       prefix="",           tags=["aws"])
    app.include_router(get_config_router(),    prefix="/config",    tags=["config"])
    app.include_router(get_terraform_router(), prefix="/terraform", tags=["terraform"])
    app.include_router(get_scheduler_router(), prefix="/scheduler", tags=["scheduler"])
    app.include_router(get_eks_router(), prefix="/eks", tags=["eks"])

    @app.get("/")
    def root():
        return {"status": "DevOps Agent running", "version": "2.0.0"}

    @app.get("/health")
    def health():
        from datetime import datetime
        return {
            "status": "healthy",
            "scheduler_jobs": len(scheduler.list_jobs()),
            "aws_connected": aws_connector.is_connected(),
            "groq_configured": bool(os.getenv("GROQ_API_KEY")),
            "openai_configured": bool(os.getenv("OPENAI_API_KEY")),
            "mcp_graph_ready": agent.graph is not None,
            "mcp_tools_loaded": len(agent._mcp_tools),
            "timestamp": datetime.utcnow().isoformat(),
        }

    return app