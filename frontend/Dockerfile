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
CMD ["npm", "run", "dev", "--", "--port", "3000", "--host", "0.0.0.0"]
