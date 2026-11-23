import { useCallback, useEffect, useRef, useState } from 'react';

interface SpeechRecognitionAlternativeLike {
  transcript: string;
}

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  length: number;
  [index: number]: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
}

interface SpeechRecognitionErrorEventLike {
  error: string;
}

interface SpeechRecognitionInstanceLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((ev: SpeechRecognitionEventLike) => void) | null;
  onerror: ((ev: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionInstanceLike;

const LANG_BCP47_MAP: Record<string, string> = {
  english: 'en-US',
  tamil: 'ta-IN',
  hindi: 'hi-IN',
  telugu: 'te-IN',
  malayalam: 'ml-IN',
  kannada: 'kn-IN',
  bengali: 'bn-IN',
  marathi: 'mr-IN',
  spanish: 'es-ES',
  french: 'fr-FR',
  german: 'de-DE',
  japanese: 'ja-JP',
};

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const win = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return win.SpeechRecognition ?? win.webkitSpeechRecognition ?? null;
}

function cleanTextForSpeech(raw: string): string {
  return raw
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/[`*_#>\[\]()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 420);
}

export function useEkuVoice(options: {
  muted: boolean;
  preferredLanguage?: string | null;
}) {
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState('');
  const [voiceError, setVoiceError] = useState<string | null>(null);

  const recognitionRef = useRef<SpeechRecognitionInstanceLike | null>(null);
  const finalCallbackRef = useRef<((text: string) => void) | null>(null);

  const isSttSupported = Boolean(getSpeechRecognitionCtor());
  const isTtsSupported =
    typeof window !== 'undefined' &&
    'speechSynthesis' in window &&
    typeof window.SpeechSynthesisUtterance === 'function';

  const stopSpeaking = useCallback(() => {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        // Ignore TTS cancel errors
      }
    }
    setIsSpeaking(false);
  }, []);

  const stopListening = useCallback(() => {
    const rec = recognitionRef.current;
    if (rec) {
      try {
        rec.stop();
      } catch {
        // Ignore stop errors
      }
    }
    setIsListening(false);
  }, []);

  useEffect(() => {
    if (options.muted) {
      stopSpeaking();
    }
  }, [options.muted, stopSpeaking]);

  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.abort();
        } catch {
          // Ignore unmount cleanup errors
        }
      }
      stopSpeaking();
    };
  }, [stopSpeaking]);

  const speak = useCallback(
    (text: string) => {
      if (options.muted || !isTtsSupported) return;
      const clean = cleanTextForSpeech(text);
      if (!clean) return;

      stopSpeaking();
      try {
        const utterance = new window.SpeechSynthesisUtterance(clean);
        const langKey = options.preferredLanguage?.toLowerCase() ?? '';
        utterance.lang =
          LANG_BCP47_MAP[langKey] ??
          (typeof navigator !== 'undefined' ? navigator.language : 'en-US') ??
          'en-US';
        utterance.rate = 1.02;
        utterance.pitch = 1.06;
        utterance.onstart = () => setIsSpeaking(true);
        utterance.onend = () => setIsSpeaking(false);
        utterance.onerror = () => setIsSpeaking(false);
        window.speechSynthesis.speak(utterance);
      } catch {
        setIsSpeaking(false);
      }
    },
    [isTtsSupported, options.muted, options.preferredLanguage, stopSpeaking]
  );

  const startListening = useCallback(
    async (onFinalTranscript: (transcript: string) => void) => {
      setVoiceError(null);
      const Ctor = getSpeechRecognitionCtor();
      if (!Ctor) {
        setVoiceError(
          'Voice recognition is not supported in this browser. You can type your message below.'
        );
        return;
      }

      // Stop TTS before listening so mic does not pick up Eku speaking
      stopSpeaking();

      // Explicitly verify microphone permission when browser exposes mediaDevices
      if (
        typeof navigator !== 'undefined' &&
        navigator.mediaDevices &&
        typeof navigator.mediaDevices.getUserMedia === 'function'
      ) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          for (const track of stream.getTracks()) {
            track.stop();
          }
        } catch {
          setVoiceError(
            'Microphone access was denied or unavailable. Enable microphone permission or use text input.'
          );
          return;
        }
      }

      try {
        const rec = new Ctor();
        rec.continuous = false;
        rec.interimResults = true;
        const langKey = options.preferredLanguage?.toLowerCase() ?? '';
        rec.lang =
          LANG_BCP47_MAP[langKey] ??
          (typeof navigator !== 'undefined' ? navigator.language : 'en-US') ??
          'en-US';

        finalCallbackRef.current = onFinalTranscript;
        let capturedFinal = '';

        rec.onresult = (ev) => {
          let interim = '';
          for (let i = ev.resultIndex; i < ev.results.length; i++) {
            const res = ev.results[i];
            const piece = res[0]?.transcript ?? '';
            if (res.isFinal) {
              capturedFinal += ` ${piece}`;
            } else {
              interim += piece;
            }
          }
          setInterimTranscript(interim.trim());
          const trimmedFinal = capturedFinal.trim();
          if (trimmedFinal) {
            capturedFinal = '';
            setInterimTranscript('');
            setIsListening(false);
            finalCallbackRef.current?.(trimmedFinal);
          }
        };

        rec.onerror = (ev) => {
          setIsListening(false);
          setInterimTranscript('');
          if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
            setVoiceError('Microphone permission blocked. Allow mic access or type below.');
          } else if (ev.error === 'no-speech') {
            setVoiceError('No speech detected. Tap the mic and speak clearly.');
          } else if (ev.error !== 'aborted') {
            setVoiceError('Voice input paused. Please try again or type below.');
          }
        };

        rec.onend = () => {
          setIsListening(false);
          setInterimTranscript('');
        };

        recognitionRef.current = rec;
        setIsListening(true);
        rec.start();
      } catch {
        setIsListening(false);
        setVoiceError('Could not start voice recognition. Type your message instead.');
      }
    },
    [options.preferredLanguage, stopSpeaking]
  );

  return {
    isListening,
    isSpeaking,
    interimTranscript,
    voiceError,
    clearVoiceError: () => setVoiceError(null),
    isSttSupported,
    isTtsSupported,
    speak,
    stopSpeaking,
    startListening,
    stopListening,
  };
}
