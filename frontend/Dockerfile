# Frontend Dockerfile
FROM node:18-alpine

WORKDIR /app

ARG BUILD_VERSION=dev
RUN echo "${BUILD_VERSION}" > BUILD_VERSION

COPY package.json package-lock.json* ./
RUN npm install --frozen-lockfile || true

COPY . .

RUN npm run build

EXPOSE 3000
# The source is bind-mounted over /app at runtime, which shadows the image's
# built dist/. So (re)build at startup, then serve the bundled production build
# with `vite preview` — instant loads, no dev-mode pre-bundling stalls.
CMD ["sh", "-c", "npm run build && npm run preview -- --port 3000 --host 0.0.0.0"]
