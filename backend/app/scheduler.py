"""
TaskScheduler — APScheduler with natural language time parsing
Supports: '3am', 'tomorrow 9am', 'in 2 hours', 'every day at midnight', etc.
"""
import re
import uuid
import asyncio
from datetime import datetime, timedelta
from typing import Optional
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.date import DateTrigger
from apscheduler.triggers.cron import CronTrigger
from apscheduler.jobstores.memory import MemoryJobStore


class TaskScheduler:
    def __init__(self):
        self.scheduler = BackgroundScheduler(
            jobstores={"default": MemoryJobStore()},
            timezone="UTC"
        )
        self.scheduler.start()
        self._jobs_meta: dict[str, dict] = {}

    # ── Public API ──────────────────────────────────────────────────────────

    def schedule_natural_language(self, command: str, time_str: str, name: str = "") -> Optional[str]:
        """Parse natural language time and schedule command. Returns job_id or None."""
        run_time = self._parse_time(time_str)
        if run_time is None:
            cron = self._parse_cron(time_str)
            if cron:
                return self._add_cron_job(command, cron, name or command)
            return None

        return self._add_date_job(command, run_time, name or command)

    def list_jobs(self) -> list:
        jobs = []
        for job in self.scheduler.get_jobs():
            meta = self._jobs_meta.get(job.id, {})
            jobs.append({
                "id": job.id,
                "name": job.name,
                "command": meta.get("command", ""),
                "next_run": str(job.next_run_time) if job.next_run_time else None,
                "status": "scheduled" if job.next_run_time else "paused",
            })
        return jobs

    def cancel_job(self, job_id: str) -> bool:
        try:
            self.scheduler.remove_job(job_id)
            self._jobs_meta.pop(job_id, None)
            return True
        except Exception:
            return False

    def shutdown(self):
        self.scheduler.shutdown(wait=False)

    # ── Internal ────────────────────────────────────────────────────────────

    def _add_date_job(self, command: str, run_time: datetime, name: str) -> str:
        job_id = str(uuid.uuid4())[:8]
        self.scheduler.add_job(
            func=self._execute_command,
            trigger=DateTrigger(run_date=run_time),
            args=[command, job_id],
            id=job_id,
            name=name,
        )
        self._jobs_meta[job_id] = {"command": command, "scheduled_at": str(run_time)}
        return job_id

    def _add_cron_job(self, command: str, cron_kwargs: dict, name: str) -> str:
        job_id = str(uuid.uuid4())[:8]
        self.scheduler.add_job(
            func=self._execute_command,
            trigger=CronTrigger(**cron_kwargs),
            args=[command, job_id],
            id=job_id,
            name=name,
        )
        self._jobs_meta[job_id] = {"command": command, "cron": cron_kwargs}
        return job_id

    def _execute_command(self, command: str, job_id: str):
        """Called by APScheduler at the scheduled time"""
        from app.agent import DevOpsAgent
        print(f"[Scheduler] Executing job {job_id}: {command}")
        agent = DevOpsAgent()
        # Run the command through the agent
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            async def run():
                chunks = []
                async for chunk in agent.stream_response(command, f"scheduler-{job_id}"):
                    chunks.append(chunk)
                return chunks
            results = loop.run_until_complete(run())
            print(f"[Scheduler] Job {job_id} completed: {len(results)} chunks")
        except Exception as e:
            print(f"[Scheduler] Job {job_id} failed: {e}")
        finally:
            loop.close()

    def _parse_time(self, time_str: str) -> Optional[datetime]:
        """Parse natural language time strings into datetime."""
        now = datetime.utcnow()
        s = time_str.lower().strip()

        # ── Relative: "in X minutes/hours/days" ───────────────────────────
        m = re.match(r"in\s+(\d+)\s+(minute|hour|day|second)s?", s)
        if m:
            val, unit = int(m.group(1)), m.group(2)
            delta = {
                "second": timedelta(seconds=val),
                "minute": timedelta(minutes=val),
                "hour": timedelta(hours=val),
                "day": timedelta(days=val),
            }[unit]
            return now + delta

        # ── "tomorrow [time]" ─────────────────────────────────────────────
        if s.startswith("tomorrow"):
            rest = s.replace("tomorrow", "").strip()
            base = now + timedelta(days=1)
            t = self._parse_clock(rest)
            if t:
                return base.replace(hour=t[0], minute=t[1], second=0, microsecond=0)
            return base.replace(hour=9, minute=0, second=0, microsecond=0)

        # ── "tonight [time]" ─────────────────────────────────────────────
        if s.startswith("tonight"):
            rest = s.replace("tonight", "").strip()
            t = self._parse_clock(rest) or (20, 0)
            dt = now.replace(hour=t[0], minute=t[1], second=0, microsecond=0)
            if dt < now:
                dt += timedelta(days=1)
            return dt

        # ── Plain clock: "3am", "3:30am", "15:00", "3 am" ────────────────
        t = self._parse_clock(s)
        if t:
            dt = now.replace(hour=t[0], minute=t[1], second=0, microsecond=0)
            if dt < now:
                dt += timedelta(days=1)  # schedule for tomorrow if time passed
            return dt

        # ── ISO / date string ────────────────────────────────────────────
        for fmt in ("%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M", "%d/%m/%Y %H:%M"):
            try:
                return datetime.strptime(s, fmt)
            except ValueError:
                pass

        return None

    def _parse_clock(self, s: str):
        """Parse clock time string → (hour, minute) or None."""
        s = s.strip()
        # "3am", "3 am", "3:30am", "3:30 am"
        m = re.match(r"^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$", s)
        if m:
            h, mn, meridiem = int(m.group(1)), int(m.group(2) or 0), m.group(3)
            if meridiem == "pm" and h != 12:
                h += 12
            elif meridiem == "am" and h == 12:
                h = 0
            return (h % 24, mn)
        return None

    def _parse_cron(self, s: str) -> Optional[dict]:
        """Parse recurring patterns → APScheduler cron kwargs."""
        s = s.lower()
        if "every day at midnight" in s or "daily midnight" in s:
            return {"hour": 0, "minute": 0}
        if "every day at" in s:
            t = self._parse_clock(s.split("every day at")[-1].strip())
            if t:
                return {"hour": t[0], "minute": t[1]}
        if "every hour" in s:
            return {"minute": 0}
        if "every minute" in s:
            return {"second": 0}
        return None

# ── Singleton instance ─────────────────────────────────────────────────────────
scheduler = TaskScheduler()