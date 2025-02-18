#!/bin/bash
echo "Following are the environment variables"
env
echo "Starting the mongodb database"
mongod --dbpath /var/lib/mongodb > mongodb.log &
sleep 2
echo "Running dtube node"
node restartMining.js &
echo
echo "Cleaning log folder..."
rm /echelon/log/*
touch /echelon/log/echelon.log
secs=5
msg=" ..."
while [ $secs -gt 0 ]
do
    printf "\r\033[KStarting in %.d seconds $msg" $((secs--))
    sleep 1
done
echo
tail -f log/echelon.log
