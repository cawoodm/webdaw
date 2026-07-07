FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY . .

# Build the project
RUN npm run build

# Expose the port Vite preview uses
EXPOSE 5173

# Serve the built app
CMD ["npm", "run", "preview", "--", "--host", "0.0.0.0"]
