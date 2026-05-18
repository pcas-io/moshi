FROM node:22-alpine
RUN apk add --no-cache wget python3 make g++
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
# Copy app files (invalidates cache on any code change)
COPY src ./src
COPY migrations ./migrations
COPY public ./public
EXPOSE 3000
CMD ["npx", "tsx", "src/index.tsx"]
