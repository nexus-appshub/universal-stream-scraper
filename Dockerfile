FROM node:18-slim

# Chromium এবং Puppeteer-এর জন্য প্রয়োজনীয় সমস্ত লিনাক্স লাইব্রেরি ইনস্টল
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-ipafont-gothic \
    fonts-wqy-zenhei \
    fonts-thai-tlwg \
    fonts-kacst \
    fonts-freefont-ttf \
    libxss1 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Puppeteer যাতে নিজস্ব ক্রোমিয়াম ডাউনলোড না করে সিস্টেমেরটা ব্যবহার করে
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 8080
CMD [ "node", "server.js" ]
