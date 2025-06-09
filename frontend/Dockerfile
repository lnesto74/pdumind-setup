# Frontend Dockerfile
FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --frozen-lockfile || true

COPY . .

RUN npm run build

EXPOSE 3000
CMD ["npm", "run", "dev", "--", "--port", "3000", "--host", "0.0.0.0"]
