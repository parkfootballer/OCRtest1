# 찰칵장부 — API 서버 + PWA 정적 파일을 한 컨테이너로 배포
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

# 의존성 먼저 설치해 레이어 캐시를 살린다
COPY server/package.json server/package-lock.json server/
RUN cd server && npm ci --omit=dev && npm cache clean --force

COPY index.html manifest.webmanifest sw.js ./
COPY css css
COPY js js
COPY icons icons
COPY server/server.js server/schema.sql server/

USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:${PORT:-8080}/api/health || exit 1
# DATABASE_URL, PORT, SIGNUP_CODE(선택), DB_SSL(선택)은 호스팅 환경변수로 넣는다
CMD ["node", "server/server.js"]
