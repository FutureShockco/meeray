#!/bin/bash

docker build -t echelon .
# alternative: docker-compose build

sleep 5

docker rm echelon
docker run -it -v $HOME/echelon/blocks:/echelon/blocks -v $HOME/echelon/mongodb:/var/lib/mongodb -p 3001:3001 -p 6001:6001 --name echelon echelon:latest ./scripts/start_dtube.sh
# alternative: docker-compose down && docker-compose up
