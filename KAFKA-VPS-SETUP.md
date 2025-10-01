# Running Kafka on VPS with Docker

This guide explains how to run only Kafka (with Zookeeper) on your VPS using Docker.

## Prerequisites

- Docker installed on your VPS
- Docker Compose installed on your VPS
- Open ports 9092 and 29092 in your VPS firewall

## Quick Start

### Option 1: Using the setup script (Recommended)

1. Upload these files to your VPS:
   - `docker-compose.kafka.yml`
   - `setup-kafka-vps.sh`

2. Make the script executable:
   ```bash
   chmod +x setup-kafka-vps.sh
   ```

3. Run the setup script:
   ```bash
   ./setup-kafka-vps.sh
   ```

The script will automatically:
- Detect your VPS IP address
- Update the Kafka configuration
- Start Kafka and Zookeeper
- Display connection information

### Option 2: Manual setup

1. Upload `docker-compose.kafka.yml` to your VPS

2. Edit the file and replace `YOUR_VPS_IP` with your actual VPS IP address:
   ```bash
   nano docker-compose.kafka.yml
   # Find: YOUR_VPS_IP
   # Replace with: your.actual.vps.ip
   ```

3. Start Kafka:
   ```bash
   docker-compose -f docker-compose.kafka.yml up -d
   ```

### Option 3: Using existing docker-compose.yml

If you have the full `docker-compose.yml` file on your VPS, run only Kafka:
```bash
docker-compose up -d zookeeper kafka
```

## Connection Details

After setup, Kafka will be accessible at:

- **From within Docker network**: `kafka:9092`
- **From your VPS host**: `localhost:29092`
- **From external machines**: `YOUR_VPS_IP:29092`

## Firewall Configuration

Make sure these ports are open in your VPS firewall:

```bash
# For UFW (Ubuntu/Debian)
sudo ufw allow 9092/tcp
sudo ufw allow 29092/tcp
sudo ufw allow 2181/tcp

# For firewalld (CentOS/RHEL)
sudo firewall-cmd --permanent --add-port=9092/tcp
sudo firewall-cmd --permanent --add-port=29092/tcp
sudo firewall-cmd --permanent --add-port=2181/tcp
sudo firewall-cmd --reload
```

## Useful Commands

### Check status
```bash
docker-compose -f docker-compose.kafka.yml ps
```

### View logs
```bash
# All logs
docker-compose -f docker-compose.kafka.yml logs -f

# Kafka only
docker-compose -f docker-compose.kafka.yml logs -f kafka

# Zookeeper only
docker-compose -f docker-compose.kafka.yml logs -f zookeeper
```

### Stop Kafka
```bash
docker-compose -f docker-compose.kafka.yml down
```

### Restart Kafka
```bash
docker-compose -f docker-compose.kafka.yml restart
```

### Stop and remove volumes (clean start)
```bash
docker-compose -f docker-compose.kafka.yml down -v
```

## Testing Kafka Connection

### From inside the Kafka container:
```bash
# Create a topic
docker exec -it meeray-kafka kafka-topics --create --topic test-topic --bootstrap-server localhost:9092 --partitions 1 --replication-factor 1

# List topics
docker exec -it meeray-kafka kafka-topics --list --bootstrap-server localhost:9092

# Produce messages
docker exec -it meeray-kafka kafka-console-producer --topic test-topic --bootstrap-server localhost:9092

# Consume messages (in another terminal)
docker exec -it meeray-kafka kafka-console-consumer --topic test-topic --from-beginning --bootstrap-server localhost:9092
```

### From your application:
Use the connection string: `YOUR_VPS_IP:29092`

Example in your application's `.env`:
```
KAFKA_BROKERS=your.vps.ip.address:29092
```

## Connecting Your Meeray Application

If your Meeray application runs elsewhere and needs to connect to this Kafka:

1. Update your application's environment variables:
   ```env
   KAFKA_BROKERS=YOUR_VPS_IP:29092
   ```

2. Ensure your application can reach the VPS on port 29092

## Troubleshooting

### Kafka won't start
```bash
# Check logs
docker-compose -f docker-compose.kafka.yml logs kafka

# Check if ports are in use
netstat -tulpn | grep -E '9092|29092|2181'
```

### Can't connect from external machine
- Verify firewall ports are open
- Check KAFKA_ADVERTISED_LISTENERS uses correct VPS IP
- Verify network security groups (if using cloud VPS)

### Reset everything
```bash
docker-compose -f docker-compose.kafka.yml down -v
docker-compose -f docker-compose.kafka.yml up -d
```

## Production Considerations

For production use, consider:

1. **Add persistence**: Already configured with volumes in the compose file
2. **Increase resources**: Adjust memory limits in docker-compose.kafka.yml
3. **Add monitoring**: Consider Kafka Manager or Confluent Control Center
4. **Security**: Add SASL/SSL authentication (requires additional configuration)
5. **Backup**: Regularly backup the volume data
6. **Multiple brokers**: For high availability, run multiple Kafka brokers

## Volume Locations

Data is persisted in Docker volumes:
- Kafka data: `kafka-data`
- Zookeeper data: `zookeeper-data`
- Zookeeper logs: `zookeeper-logs`

To backup:
```bash
docker run --rm -v kafka-data:/data -v $(pwd):/backup alpine tar czf /backup/kafka-backup.tar.gz /data
```
