FROM node:latest
LABEL "project.home"="https://github.com/nannal/echelon"
RUN git clone git://github.com/skzap/echelon
WORKDIR /echelon
RUN npm install
EXPOSE 6001
EXPOSE 3001
ENV DB_URL 'mongodb://localhost:27017'
ENV DB_NAME 'echelon'
ENV NODE_OWNER 'default user'
ENV NODE_OWNER_PUB 'Invalid Key'
ENV NODE_OWNER_PRIV 'Invalid Key'
ENV PEERS 'ws://api.echelon.wtf:6001,ws://echelon.nannal.com:6001,ws://82.66.109.22:6001'
CMD ["npm", "start"]
