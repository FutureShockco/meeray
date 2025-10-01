#!/bin/bash

# Kafka Docker Setup Script for VPS
# This script sets up and runs Kafka on your VPS using Docker

echo "==================================="
echo "Kafka VPS Setup Script"
echo "==================================="

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    echo "❌ Docker is not installed. Please install Docker first."
    exit 1
fi

# Detect Docker Compose command (docker-compose or docker compose)
if command -v docker-compose &> /dev/null; then
    DOCKER_COMPOSE="docker-compose"
    echo "✓ Found docker-compose (standalone)"
elif docker compose version > /dev/null 2>&1; then
    DOCKER_COMPOSE="docker compose"
    echo "✓ Found docker compose (plugin)"
else
    echo "❌ Docker Compose is not installed. Please install Docker Compose first."
    echo "If you have Docker Desktop, try running: docker compose version"
    exit 1
fi

# Get VPS IP address
echo ""
echo "Detecting VPS IP address..."
VPS_IP=$(curl -s ifconfig.me)
echo "✓ Detected VPS IP: $VPS_IP"

# Update docker-compose.kafka.yml with actual IP
echo ""
echo "Updating Kafka configuration with VPS IP..."
sed -i "s/YOUR_VPS_IP/$VPS_IP/g" docker-compose.kafka.yml
echo "✓ Configuration updated"

# Stop any existing Kafka containers
echo ""
echo "Stopping any existing Kafka containers..."
$DOCKER_COMPOSE -f docker-compose.kafka.yml down

# Start Kafka and Zookeeper
echo ""
echo "Starting Kafka and Zookeeper..."
$DOCKER_COMPOSE -f docker-compose.kafka.yml up -d

# Wait for services to start
echo ""
echo "Waiting for services to initialize..."
sleep 10

# Check status
echo ""
echo "Checking service status..."
$DOCKER_COMPOSE -f docker-compose.kafka.yml ps

echo ""
echo "==================================="
echo "✓ Kafka Setup Complete!"
echo "==================================="
echo ""
echo "Kafka Connection Details:"
echo "  - Internal (Docker): kafka:9092"
echo "  - External (VPS):    $VPS_IP:29092"
echo ""
echo "To view logs:"
echo "  $DOCKER_COMPOSE -f docker-compose.kafka.yml logs -f"
echo ""
echo "To stop Kafka:"
echo "  $DOCKER_COMPOSE -f docker-compose.kafka.yml down"
echo ""
echo "To restart Kafka:"
echo "  $DOCKER_COMPOSE -f docker-compose.kafka.yml restart"
echo ""
