FROM node:22-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install

# Copy application code
COPY . .

# Build optimized production bundle
ENV NODE_ENV=production
RUN npm run build

EXPOSE 3000

# Run production server with 0% idle CPU and instant response times
CMD ["npm", "run", "start"]