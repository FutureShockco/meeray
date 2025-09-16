# Use Node 20 as the base image
FROM node:20

# Set working directory
WORKDIR /app

# Copy package files and install dependencies

# Copy package files and install ALL dependencies (including devDependencies)
COPY package*.json ./
RUN npm install

# Copy the rest of the application
COPY . .


# Build the TypeScript code
RUN npm run build

# Remove devDependencies for a smaller production image
RUN npm prune --production

# Expose default API and P2P ports (customize as needed)
EXPOSE 3001 6001


# Set environment variables (override in docker-compose or at runtime)
ENV NODE_ENV=production

# Start the app using compiled JS
CMD ["node", "dist/main.js"]
