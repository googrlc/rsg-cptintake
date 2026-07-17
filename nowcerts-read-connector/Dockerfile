FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

ENV PORT=8082
EXPOSE 8082

CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT} --log-level info"]
