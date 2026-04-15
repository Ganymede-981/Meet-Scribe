import Groq from 'groq-sdk';
import { createReadStream } from 'fs';

let client: Groq | null = null;

// ─── Retry & Cascade Helper ──────────────────────────────────
async function withFallbackAndRetry<T>(
  fnFactory: (modelName: string) => Promise<T>,
  models = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'llama3-8b-8192', 'llama3-70b-8192'],
  retriesPerModel = 1
): Promise<T> {
  let currentModelIdx = 0;
  let currentRetries = retriesPerModel;

  while (currentModelIdx < models.length) {
    const currentModel = models[currentModelIdx];
    try {
      return await fnFactory(currentModel);
    } catch (err: any) {
      const msg = err?.message?.toLowerCase() || '';
      const isRateLimit = msg.includes('429');

      if (isRateLimit) {
        if (currentRetries > 0) {
          const waitMatch = msg.match(/try again in ([\d.]+)s/i);
          const waitMs = waitMatch ? (parseFloat(waitMatch[1]) * 1000) + 1000 : 2000;
          console.warn(`[Groq] Rate limit hit on ${currentModel}. Waiting ${Math.round(waitMs / 1000)}s before retry...`);
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          currentRetries--;
        } else {
          currentModelIdx++;
          currentRetries = retriesPerModel;
          if (currentModelIdx < models.length) {
            const nextModel = models[currentModelIdx];
            console.warn(`[Groq] Switching to fallback model: ${nextModel}. Raw Error: ${err?.message}`);
          } else {
            console.error(`[Groq] All fallback models exhausted. Last Error: ${err?.message}`);
            throw err;
          }
        }
      } else {
        throw err; // Throw non-rate-limit errors immediately
      }
    }
  }
  throw new Error('Exhausted model list');
}

function getClient(): Groq {
  if (!client) {
    const key = process.env.GROQ_API_KEY;
    if (!key) throw new Error('GROQ_API_KEY is not set in environment');
    client = new Groq({ apiKey: key });
  }
  return client;
}

// ─── Summarize a text transcript ─────────────────────────────
export async function summarizeTranscript(transcript: string): Promise<string> {
  if (!transcript || transcript.trim().length < 20) {
    return 'The meeting was too short to generate a meaningful summary.';
  }

  // Ensure transcript doesn't exceed 6000 Tokens (roughly 24000 chars, limit to 14000 for safety)
  const MAX_CHARS = 14000;
  let processingTranscript = transcript.trim();
  if (processingTranscript.length > MAX_CHARS) {
    processingTranscript = processingTranscript.slice(0, MAX_CHARS) + "\n\n...[Transcript truncated due to token length limits]...";
  }

  const prompt = `You are an expert meeting analyst. Analyze this meeting transcript and return a well-structured summary.

Transcript:
${processingTranscript}

Provide a structured summary with these exact sections:
**📋 Meeting Overview**
One sentence describing what this meeting was about.

**💡 Key Discussion Points**
- Bullet list of main topics discussed

**✅ Decisions Made**
- Bullet list of concrete decisions reached

**📌 Action Items**
- [Person responsible] - Task description (due date if mentioned, otherwise leave blank)

**🔄 Follow-up Steps**
- What needs to happen next

Keep each section concise and actionable.`;

  const result = await withFallbackAndRetry((modelName) => {
    const groq = getClient();
    return groq.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: modelName,
      temperature: 0.2, // Low temperature for factual summarization
    });
  });

  return result.choices[0]?.message?.content || 'Summary could not be generated.';
}

// ─── Process audio file using Whisper & Llama-3 ───────────────
export async function processAudio(
  audioPath: string,
  _mimeType: string // Parameter retained for API route compatibility
): Promise<{ transcript: string[]; summary: string }> {
  const groq = getClient();

  console.log(`[Groq] Executing Whisper Transcription...`);
  // Step 1: Transcribe via whisper-large-v3
  const transcriptionResult = await groq.audio.transcriptions.create({
    file: createReadStream(audioPath),
    model: 'whisper-large-v3',
    response_format: 'text',
  });

  // The 'text' response format returns raw string transcript directly. 
  // Depending on SDK shapes, it may wrap in an object, but usually it's plain text.
  let transcriptText = typeof transcriptionResult === 'string'
    ? transcriptionResult
    : (transcriptionResult as any).text || '';

  transcriptText = transcriptText.trim();

  console.log(`[Groq] Transcription complete. Length: ${transcriptText.length} chars. Generating Summary...`);

  // Step 2: Summarize via Llama 3
  const summaryText = await summarizeTranscript(transcriptText);

  // Split transcript into individual lines for real-time-like playback
  const transcriptLines = transcriptText
    .split('\\n')
    // Fallback: if Whisper gives a single giant block, try to split by sentence boundaries to simulate lines.
    .flatMap((l: string) => l.match(/[^.!?]+[.!?]+/g) || [l])
    .map((l: string) => l.trim())
    .filter((l: string) => l.length > 0);

  return {
    transcript: transcriptLines.length > 0 ? transcriptLines : ['[Audio was unintelligible or empty]'],
    summary: summaryText,
  };
}

// ─── Identify if a URL is a valid Google Meet URL ─────────────
export function isValidMeetUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname === 'meet.google.com' &&
      new RegExp('^/[a-z]{3}-[a-z]{4}-[a-z]{3}$').test(parsed.pathname)
    );
  } catch {
    return false;
  }
}
