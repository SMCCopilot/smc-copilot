-- 0014: allow the browser's own on-device speech recognition as a speech engine tag.
-- Used only when the browser confirms it processes locally (audio stays on the device); recorded in the voice log and
-- on chat messages like the other engines.
alter table voice_events drop constraint if exists voice_events_engine_check;
alter table voice_events add constraint voice_events_engine_check
  check (engine in ('whisper-web','moonshine-web','parakeet-server','whispercpp-server','browser-local','typed'));
alter table chat_messages drop constraint if exists chat_messages_stt_engine_check;
alter table chat_messages add constraint chat_messages_stt_engine_check
  check (stt_engine in ('whisper-web','moonshine-web','parakeet-server','whispercpp-server','browser-local','typed'));
