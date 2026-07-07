import os
import uvicorn
from dotenv import load_dotenv

load_dotenv()

from app import create_app
from app.scheduler import scheduler
from app.aws_connector import aws_connector

app = create_app()

def kill_process_on_port(port: int):
    import subprocess
    import signal
    import time
    try:
        # lsof -t -i :<port> returns only PIDs using that port
        output = subprocess.check_output(["lsof", "-t", "-i", f":{port}"], text=True)
        pids = [int(pid.strip()) for pid in output.splitlines() if pid.strip()]
        current_pid = os.getpid()
        for pid in pids:
            if pid != current_pid:
                print(f"🔄 Port {port} is in use. Terminating existing process (PID: {pid})...")
                os.kill(pid, signal.SIGTERM)
                time.sleep(0.5)
    except subprocess.CalledProcessError:
        # Port is not in use (lsof returned non-zero exit code)
        pass
    except Exception as e:
        print(f"⚠️ Could not clear port {port}: {e}")

if __name__ == "__main__":
    port = int(os.getenv("PORT", 8000))
    kill_process_on_port(port)
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=port,
        reload=os.getenv("ENV", "production") == "development",
    )