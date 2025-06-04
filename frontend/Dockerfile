# Frontend Dockerfile
FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --frozen-lockfile || true

COPY . .

RUN npm run build

EXPOSE 3000
CMD ["npm", "run", "preview", "--", "--port", "3000", "--host"]
