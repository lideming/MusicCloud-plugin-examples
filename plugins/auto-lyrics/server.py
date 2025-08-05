import asyncio
import stable_whisper
import torch
from fastapi import FastAPI, Form, UploadFile, File, HTTPException
from fastapi.responses import PlainTextResponse
from fastapi.middleware.cors import CORSMiddleware
from typing import List, Optional, cast, Any
from stable_whisper.result import WordTiming
import os
import tempfile
import traceback

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
print(f"Using device: {DEVICE}")

app = FastAPI(title="Lyrics Worker")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

model = None

def load_model():
    try:
        global model
        print("Loading model...")
        model = stable_whisper.load_model('turbo', device=DEVICE)
        print("Loaded.")
    except Exception as e:
        print("Error loading model")
        traceback.print_exc()
        model = None

asyncio.run(asyncio.to_thread(load_model))

def format_to_custom_lrc(result: stable_whisper.WhisperResult, align: bool) -> str:
    output_lines = [
        "[auto-lyrics]",
        f"[lang:{result.language}]",
        ""
    ]
    prev_segment_end = 0.0
    for segment in result.segments:
        line_parts = []
        words = cast(List[WordTiming], segment.words)
        for word in words:
            line_parts.append(f"[{word.start:.3f}]{word.word}")

        if not align and (segment.start - prev_segment_end) > 5 and prev_segment_end > 0:
            output_lines.append(f"[{prev_segment_end + 1.0:.3f}]")
        prev_segment_end = segment.end
        
        if line_parts:
            output_lines.append("".join(line_parts))
            
    return "\n".join(output_lines)

is_processing = False

@app.post("/transcribe", response_class=PlainTextResponse)
async def transcribe_audio(file: UploadFile = File(...), text: Optional[str] = Form(None), lang: Optional[str] = Form(None)):
    if not model:
        raise HTTPException(status_code=500, detail="model is not loaded")
    filename = cast(str, file.filename)

    print(f"received file: {filename}")

    temp_audio_path = None
    try:
        if file.size is None:
            raise HTTPException(status_code=400, detail="unable to get file size")
        if file.size > 50 * 1024 * 1024:
            raise HTTPException(status_code=413, detail="file size exceeds 50MB limit")
        with tempfile.NamedTemporaryFile(delete=False, suffix=os.path.splitext(filename)[1]) as temp_audio:
            content = await file.read()
            temp_audio_path = temp_audio.name
            print(f"saving to: {temp_audio_path}")
            temp_audio.write(content)

        global is_processing
        if is_processing:
            raise HTTPException(status_code=429, detail="Another transcription is already in progress. Please wait until it completes.")
        is_processing = True
        is_align = len(text or '') > 0
        try:
            if is_align:
                print("Aligning...")
                result = await asyncio.to_thread(lambda: model.align(temp_audio_path, text=text, language=lang, original_split=True))
            else:
                print("Transcribing...")
                result = await asyncio.to_thread(lambda: model.transcribe(temp_audio_path, language=lang))
        finally:
            is_processing = False
        print("Formatting...")

        custom_content = format_to_custom_lrc(cast(Any, result), is_align)

        return PlainTextResponse(content=custom_content)

    except Exception as e:
        print(e)
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"error processing")
    finally:
        if temp_audio_path and os.path.exists(temp_audio_path):
            os.remove(temp_audio_path)
            print(f"deleted: {temp_audio_path}")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info")
