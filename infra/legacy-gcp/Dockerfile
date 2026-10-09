FROM node:20-slim

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Build
COPY . .
RUN npm run build

# Run sensor pipeline
ENTRYPOINT ["npm", "run", "pipeline:once", "--"]
CMD ["--source", "anbi-nl"]
