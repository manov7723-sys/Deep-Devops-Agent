from fastapi import APIRouter

import json
import uuid
from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import Optional
from app.agent import agent

class ChatMessage(BaseModel):
    message: str
    session_id: Optional[str] = None

def get_router() -> APIRouter:
    router = APIRouter()

    @router.post("/")
    async def chat(msg: ChatMessage):
        session_id = msg.session_id or str(uuid.uuid4())
        async def generate():
            async for chunk in agent.stream_response(msg.message, session_id):
                yield f"data: {json.dumps(chunk)}\n\n"
            yield "data: [DONE]\n\n"
        return StreamingResponse(generate(), media_type="text/event-stream")

    @router.delete("/session/{session_id}")
    def clear_session(session_id: str):
        if session_id in agent.sessions:
            del agent.sessions[session_id]
        agent.session_cloud.pop(session_id, None)
        agent.session_resource.pop(session_id, None)
        return {"status": "cleared", "session_id": session_id}

    @router.get("/sessions")
    def list_sessions():
        return {"sessions": list(agent.sessions.keys()), "count": len(agent.sessions)}

    return router