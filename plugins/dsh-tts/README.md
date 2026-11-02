# dsh-tts

캐릭터가 말풍선에 띄우는 대사를 TTS로 읽어 주고, **그 소리**로 입을 움직이는 옵트인 플러그인입니다.
에이전트 응답 낭독·페르소나·감정 태그·STT는 다루지 않습니다.

- **Host**: `GET /dsh-tts/state`, `POST /dsh-tts/speak` — 표준 OpenAI 호환 `/audio/speech`로 스트리밍 중계. API 키는 호스트 환경변수에만 있습니다.
- **Client** (`lib/client.js`, 빌드 산출물 커밋됨): `dsc:say` 이벤트를 듣고 PCM16을 첫 청크부터 재생, Analyser RMS로 `window.__dsc.voice({ speaking, level, until })`를 갱신합니다.
- **말풍선 타이밍은 TTS와 무관**: 꺼짐/오류/지연이면 `voice(null)`일 뿐 dsc.js의 숨김 타이머는 그대로입니다.

## 옵트인

기본값은 `enabled: false`입니다. 꺼져 있으면 **라우트가 등록되지 않고**(/state도 404), 클라이언트는 아무것도 붙이지 않으며 외부 요청을 보내지 않습니다.

켜려면 `cordis.patch.yml` config에서 `enabled: true`로 바꾸고 키를 환경변수로 노출하세요:

```bash
export OPENAI_API_KEY=sk-...
```

## 설정 (기본값)

```yaml
enabled: false
openai:
  baseUrl: "https://api.openai.com/v1"
  model: "gpt-4o-mini-tts"
  voice: "alloy"
  speed: 1.0                 # 1.0이면 요청에서 생략
  apiKeyEnv: "OPENAI_API_KEY"
  headers: {}                # 업스트림 추가 헤더 (Authorization은 덮어쓸 수 없음)
  timeoutMs: 30000
  extraBody: {}              # 모델 전용 필드(비이식성). 예: Drama 3 ref_audio/ref_text. 표준 필드가 우선
stream:
  enabled: true              # 스트리밍이 유일한 전송 방식이라 끄면 기능 전체가 꺼짐
  pcmSampleRate: 24000
voiceLines:                  # 대사 종류별 on/off
  reactions: true
  status: false
  mutters: false
  others: true
cache:
  enabled: true              # false로 끌 수 있음(매 발화마다 업스트림 호출)
  maxEntries: 200
  ttlMs: 604800000
  maxCacheBytes: 33554432    # 이보다 큰 오디오는 캐시하지 않음
limits:
  maxCharsPerLine: 300
  maxBytes: 16777216
```

## 라우트 계약

`GET /dsh-tts/state` → 200

```json
{ "enabled": true, "pcmSampleRate": 24000,
  "voiceLines": { "reactions": true, "status": false, "mutters": false, "others": true } }
```

`POST /dsh-tts/speak` body `{ "text": "..." }`

| 상황 | 응답 |
|---|---|
| 잘못된 JSON / 빈 텍스트 / `maxCharsPerLine` 초과 | 400 `{error:{message}}` |
| `apiKeyEnv` 미설정 또는 키 없음 | 503 `{error:{message}}` |
| 캐시 hit | 200 `audio/pcm`, `cache-control: no-store`, `x-cache: hit` |
| 캐시 miss | 200 `audio/pcm` 스트리밍, `x-cache: miss` |
| 업스트림 비 2xx | 그 상태코드 + JSON `{error:{message}}` (오디오 헤더 전에) |
| 플러그인 disabled | 404 (라우트 미등록) |

업스트림 요청은 표준 OpenAI 필드 `{ model, voice, input, response_format: "pcm", stream_format: "audio", speed? }` +
`Authorization: Bearer`이며, `openai.extraBody`가 있으면 그대로 병합됩니다(표준 필드가 우선).
`extraBody`는 **모델 전용**입니다 — 예: Drama 3의 `ref_audio`/`ref_text`/`language`/`max_new_tokens`.
`voice`는 엔드포인트가 아는 이름(OpenAI 보이스 또는 서버에 등록된 보이스 id)이어야 하며, `default`처럼 고정되지 않은
이름은 발화마다 화자가 바뀔 수 있습니다.
클라이언트가 연결을 끊으면 업스트림 요청도 abort됩니다.

## 빌드 / 테스트

```bash
node build.mjs        # src/client/index.js -> lib/client.js (커밋 대상)
node --test test/     # node:test, 외부 의존성 없음
```

esbuild는 `ESBUILD` 환경변수(경로) → 설치된 `esbuild` 패키지 순서로 찾습니다.
`lib/client.js`는 커밋되어 있으므로 빌드 없이 동작합니다.

## 프라이버시

- 대사 텍스트는 **설정한 엔드포인트로만** 전송됩니다(`openai.baseUrl`). 로컬 로그에는 남기지 않습니다.
- API 키는 호스트 프로세스의 환경변수에서 읽고 브라우저로 전달하지 않습니다.
- 혼잣말(`mutters`)은 모델 추론 요약이 섞일 수 있어 **기본 꺼짐**입니다.
- `/dsh-tts/speak` 응답은 `no-store`이며, 캐시는 호스트 메모리에만 존재합니다.
