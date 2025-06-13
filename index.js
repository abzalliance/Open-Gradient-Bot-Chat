const fs = require('fs');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const readline = require('readline');
const { Keypair } = require('@solana/web3.js');
const bs58 = require('bs58').default;
const nacl = require('tweetnacl');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const Table = require('cli-table');

const MAX_QUEUE_DISPLAY = 1;
const MAX_COMPLETED_DISPLAY = 2;

console.clear = () => process.stdout.write('\u001B[2J\u001B[3J\u001B[H');

function getWorkerCount(defaultVal = 5, maxVal = 15) {
    return new Promise(resolve => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
        rl.question(`\nMasukkan jumlah worker (default ${defaultVal}, max ${maxVal}): `, (answer) => {
            rl.close();
            let input = parseInt((answer || '').trim());
            if (isNaN(input)) input = defaultVal;
            if (input < 1) input = 1;
            if (input > maxVal) input = maxVal;
            resolve(input);
        });
    });
}


function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function formatTime(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
    const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
    const seconds = String(totalSeconds % 60).padStart(2, '0');
    return `${hours}:${minutes}:${seconds}`;
}

function truncateAddress(address) {
    if (!address || address === 'Waiting...') return address;
    return address.substring(0, 5) + '...' + address.substring(address.length - 5);
}

function truncateText(text, maxLength = 20) {
    if (!text) return '';
    return text.length > maxLength ? text.substring(0, maxLength) + '...' : text;
}

if (isMainThread) {
    class SolanaAutoChat {
        constructor(maxWorkers) {
        this.maxWorkers = maxWorkers;
        this.privateKeys = [];
        this.proxies = [];
        this.chatTopics = [];
        this.workers = [];
        this.workerStats = new Map();
        this.queue = [];
        this.completed = [];
        this.currentIndex = 0;
        this.totalPoints = 0;
        this.loadData();
    }

        loadData() {
            try {
                const data = fs.readFileSync('privkey.txt', 'utf8');
                const rawKeys = data.split('\n').filter(key => key.trim() !== '');
                this.privateKeys = [];
                for (let i = 0; i < rawKeys.length; i++) {
                    const key = rawKeys[i].trim();
                    try {
                        const decoded = bs58.decode(key);
                        Keypair.fromSecretKey(decoded);
                        this.privateKeys.push(key);
                    } catch (error) {
                        console.error(`[ERROR] Invalid private key at line ${i+1}:`, error.message);
                    }
                }
                if (this.privateKeys.length === 0) {
                    console.error('[FATAL] Tidak ada private key valid di file privkey.txt!');
                    process.exit(1);
                }
            } catch (error) {
                console.error('[FATAL] Gagal membaca file privkey.txt:', error.message);
                process.exit(1);
            }

            try {
                if (fs.existsSync('proxies.txt')) {
                    const data = fs.readFileSync('proxies.txt', 'utf8');
                    this.proxies = data.split('\n').filter(proxy => proxy.trim() !== '');
                }
            } catch (error) {
                console.error('[WARNING] Gagal membaca proxies.txt:', error.message);
            }

            try {
                const data = fs.readFileSync('chat.txt', 'utf8');
                this.chatTopics = data.split('\n').filter(topic => topic.trim() !== '');
            } catch (error) {
                console.error('[FATAL] Gagal membaca file chat.txt:', error.message);
                process.exit(1);
            }
        }

        initializeQueue() {
            this.queue = this.privateKeys.map((privateKey, index) => ({
                id: index + 1,
                privateKey,
                proxy: this.proxies.length > 0 ? this.proxies[index % this.proxies.length] : null,
                status: 'queue',
                chatTotal: 0,
                points: 0,
                process: 'In queue...',
                address: 'Waiting...'
            }));
        }

        createWorker(taskData) {
            const worker = new Worker(__filename, {
                workerData: {
                    ...taskData,
                    chatTopics: this.chatTopics
                }
            });

            worker.on('message', (message) => {
                this.handleWorkerMessage(worker.threadId, message);
            });

            worker.on('error', (error) => {
                console.error(`Worker ${worker.threadId} error:`, error);
                this.handleWorkerComplete(worker.threadId);
            });

            worker.on('exit', (code) => {
                if (code !== 0) {
                    console.error(`Worker ${worker.threadId} stopped with exit code ${code}`);
                }
                this.handleWorkerComplete(worker.threadId);
            });

            return worker;
        }

        handleWorkerMessage(threadId, message) {
            const stats = this.workerStats.get(threadId);
            if (!stats) return;

            switch (message.type) {
                case 'status_update':
                    stats.status = message.status;
                    stats.process = message.process;
                    if (message.address) stats.address = message.address;
                    if (message.chatTotal !== undefined) stats.chatTotal = message.chatTotal;
                    if (message.points !== undefined) stats.points = message.points;
                    break;
                case 'error':
                    stats.status = 'error';
                    stats.process = `Error: ${message.error}`;
                    break;
                case 'complete':
                    stats.status = 'done';
                    stats.process = message.reason || 'Completed';
                    if (message.points !== undefined) stats.points = message.points;
                    this.completed.push(stats);
                    this.handleWorkerComplete(threadId);
                    break;
            }
        }

        handleWorkerComplete(threadId) {
            const workerIndex = this.workers.findIndex(w => w.threadId === threadId);
            if (workerIndex !== -1) {
                this.workers.splice(workerIndex, 1);
                this.workerStats.delete(threadId);
                this.startNextWorker();
            }
        }

        startNextWorker() {
            if (this.currentIndex < this.privateKeys.length && this.workers.length < this.maxWorkers) {
                const taskData = this.queue[this.currentIndex];
                const worker = this.createWorker(taskData);
                
                this.workers.push(worker);
                this.workerStats.set(worker.threadId, {
                ...taskData,
                status: 'running',
                process: 'Starting...'
                });
                
                this.currentIndex++;
                
                if (this.workers.length < this.maxWorkers) {
                setTimeout(() => this.startNextWorker(), 100);
                }
            }
        }

        calculateTotalPoints() {
            let total = 0;
            this.completed.forEach(stats => {
                total += stats.points || 0;
            });
            this.workers.forEach(worker => {
                const stats = this.workerStats.get(worker.threadId);
                if (stats) {
                    total += stats.points || 0;
                }
            });
            return total;
        }

        displayTable() {
            console.clear();
            console.log('                  t.me/boterdrop \x1b[34m-= Auto Chat OpenGradient =-\x1b[0m t.me/boterdrop                  ');

            const table = new Table({
                head: ['No', 'Proxy', 'Address', 'Status', 'Chat Total', 'Points', 'Process'],
                colWidths: [5, 12, 15, 9, 12, 8, 25]
            });

            const recentCompleted = this.completed.slice(-MAX_COMPLETED_DISPLAY);
            recentCompleted.forEach(stats => {
                table.push([
                    stats.id,
                    stats.proxy ? 'Proxy' : 'No proxy',
                    truncateAddress(stats.address),
                    '\x1b[32mdone\x1b[0m',
                    stats.chatTotal,
                    stats.points || 0,
                    truncateText(stats.process)
                ]);
            });

            if (recentCompleted.length > 0 && (this.workers.length > 0 || this.currentIndex < this.privateKeys.length)) {
                table.push(['-', '-', '-', '-', '-', '-', '-']);
            }

            this.workers.forEach(worker => {
                const stats = this.workerStats.get(worker.threadId);
                if (stats) {
                    table.push([
                        stats.id,
                        stats.proxy ? 'Proxy' : 'No proxy',
                        truncateAddress(stats.address),
                        '\x1b[33mrunning\x1b[0m',
                        stats.chatTotal,
                        stats.points || 0,
                        truncateText(stats.process)
                    ]);
                }
            });

            const queueToShow = this.queue.slice(this.currentIndex, this.currentIndex + MAX_QUEUE_DISPLAY);
            queueToShow.forEach(task => {
                table.push([
                    task.id,
                    'Waiting...',
                    'Waiting...',
                    '\x1b[36mqueue\x1b[0m',
                    0,
                    0,
                    'In queue...'
                ]);
            });

            if (this.currentIndex + MAX_QUEUE_DISPLAY < this.privateKeys.length) {
                table.push(['-', '-', '-', '-', '-', '-', '-']);
                const remaining = this.privateKeys.length - this.currentIndex - MAX_QUEUE_DISPLAY;
                table.push([`+${remaining}`, 'Waiting...', 'Waiting...', '\x1b[36mqueue\x1b[0m', 0, 0, 'In queue...']);
            }

            console.log(table.toString());
            
            const totalPoints = this.calculateTotalPoints();
            console.log(`\n\x1b[34mt.me/boterdrop - RINGKASAN\x1b[0m :\nTotal Akun: \x1b[32m${this.privateKeys.length}\x1b[0m | Completed: \x1b[32m${this.completed.length}\x1b[0m | Running: \x1b[34m${this.workers.length}\x1b[0m | Queue: \x1b[33m${Math.max(0, this.privateKeys.length - this.currentIndex)}\x1b[0m | Total Points: \x1b[32m${totalPoints}\x1b[0m`);
        }

        async run() {

            while (true) {
                this.initializeQueue();
                this.currentIndex = 0;
                this.completed = [];
                this.workers = [];
                this.workerStats.clear();

                for (let i = 0; i < Math.min(this.maxWorkers, this.privateKeys.length); i++) {
                    this.startNextWorker();
                }

                const displayInterval = setInterval(() => {
                    this.displayTable();
                }, 1000);

                while (this.workers.length > 0 || this.currentIndex < this.privateKeys.length) {
                    await delay(1000);
                }

                clearInterval(displayInterval);
                this.displayTable();

                console.log('\n\x1b[32mAll accounts processed. Waiting 12 hours...\x1b[0m');
                await this.countdown(12 * 60 * 60 * 1000);
            }
        }

        async countdown(duration) {
            let remaining = duration;
            const animationChars = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
            let animationIndex = 0;
            
            while (remaining > 0) {
                process.stdout.write(`\r[\x1b[34m!\x1b[0m]  \x1b[34m${animationChars[animationIndex]}\x1b[0m  Countdown: ${formatTime(remaining)}`);
                await delay(100);
                remaining -= 100;
                animationIndex = (animationIndex + 1) % animationChars.length;
            }
            process.stdout.write(`\r[\x1b[34m!\x1b[0m] \x1b[32m✔\x1b[0m Countdown: Complete `);
            console.log('');
        }
    }

    (async () => {
        const maxWorkers = await getWorkerCount(5, 15);
        const bot = new SolanaAutoChat(maxWorkers);
        await bot.run();
    })().catch((err) => {
        console.error('[FATAL] Uncaught error:', err.message);
    });

} else {
    class WorkerBot {
        constructor(data) {
            this.privateKey = data.privateKey;
            this.proxy = data.proxy;
            this.chatTopics = data.chatTopics;
            this.id = data.id;
            this.currentProxy = this.proxy;
            this.proxyRetries = 0;
            this.maxProxyRetries = 3;
            this.currentPoints = 0;
        }

        sendMessage(type, data = {}) {
            parentPort.postMessage({ type, ...data });
        }

        createAxiosInstance() {
            const config = {
                timeout: 30000,
                headers: {
                    'accept': '*/*',
                    'accept-encoding': 'gzip, deflate, br, zstd',
                    'accept-language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
                    'dnt': '1',
                    'origin': 'https://www.bitquant.io',
                    'priority': 'u=1, i',
                    'referer': 'https://www.bitquant.io/',
                    'sec-ch-ua': '"Google Chrome";v="137", "Chromium";v="137", "Not/A)Brand";v="24"',
                    'sec-ch-ua-mobile': '?0',
                    'sec-ch-ua-platform': '"Windows"',
                    'sec-fetch-dest': 'empty',
                    'sec-fetch-mode': 'cors',
                    'sec-fetch-site': 'cross-site',
                    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36'
                }
            };
            
            if (this.currentProxy) {
                config.httpsAgent = new HttpsProxyAgent(this.currentProxy);
                config.httpAgent = new HttpsProxyAgent(this.currentProxy);
            }
            
            return axios.create(config);
        }

        async makeRequest(method, url, data = null, headers = {}) {
            let attempts = 0;
            
            while (attempts < this.maxProxyRetries + 1) {
                try {
                    const axiosInstance = this.createAxiosInstance();
                    const config = {
                        method: method,
                        url: url,
                        headers: { ...axiosInstance.defaults.headers, ...headers }
                    };
                    
                    if (data) {
                        if (method.toLowerCase() === 'post' && headers['content-type'] === 'application/x-www-form-urlencoded') {
                            config.data = data;
                        } else {
                            config.data = data;
                            config.headers['content-type'] = 'application/json';
                        }
                    }
                    
                    const response = await axiosInstance(config);
                    this.proxyRetries = 0;
                    return response.data;
                    
                } catch (error) {
                    if (error.response && error.response.status === 403) {
                        throw new Error('403_RESTART_NEEDED');
                    }
                    
                    attempts++;
                    if (attempts >= this.maxProxyRetries + 1) {
                        throw error;
                    }
                    await this.sleep(2000);
                }
            }
        }

        async checkWhitelist(address) {
            const url = `https://quant-api.opengradient.ai/api/whitelisted?address=${address}`;
            return await this.makeRequest('GET', url);
        }

        async autoRegister(address) {
            try {
                const url = 'https://quant-api.opengradient.ai/api/invite/use';
                const payload = {
                    code: "KiaTT14jFmoCGg",
                    address: address
                };
                await this.makeRequest('POST', url, payload);
                return true;
            } catch (error) {
                return false;
            }
        }

        async authWallet(address, message, signature) {
            const url = 'https://quant-api.opengradient.ai/api/verify/solana';
            const payload = { address, message, signature };
            return await this.makeRequest('POST', url, payload);
        }

        async accountSign(token) {
            const url = 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=AIzaSyBDdwO2O_Ose7LICa-A78qKJUCEE3nAwsM';
            const payload = { token: token, returnSecureToken: true };
            const headers = {
                //'x-client-data': 'CIq2yQEIpLbJAQipncoBCITeygEIlaHLAQiRo8sBCIWgzQEI4vDOAQiQ8s4B',
                'x-client-version': 'Chrome/JsCore/11.6.0/FirebaseCore-web',
                'x-firebase-gmpid': '1:976084784386:web:bb57c2b7c2642ce85b1e1b'
            };
            return await this.makeRequest('POST', url, payload, headers);
        }

        async accountLookup(idToken) {
            const url = 'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=AIzaSyBDdwO2O_Ose7LICa-A78qKJUCEE3nAwsM';
            const payload = { idToken: idToken };
            const headers = {
                //'x-client-data': 'CIq2yQEIpLbJAQipncoBCITeygEIlaHLAQiRo8sBCIWgzQEI4vDOAQiQ8s4B',
                'x-client-version': 'Chrome/JsCore/11.6.0/FirebaseCore-web',
                'x-firebase-gmpid': '1:976084784386:web:bb57c2b7c2642ce85b1e1b'
            };
            return await this.makeRequest('POST', url, payload, headers);
        }

        async getToken(refreshToken) {
            const url = 'https://securetoken.googleapis.com/v1/token?key=AIzaSyBDdwO2O_Ose7LICa-A78qKJUCEE3nAwsM';
            const payload = `grant_type=refresh_token&refresh_token=${refreshToken}`;
            const headers = {
                'content-type': 'application/x-www-form-urlencoded',
                //'x-client-data': 'CIq2yQEIpLbJAQipncoBCITeygEIlaHLAQiRo8sBCIWgzQEI4vDOAQiQ8s4B',
                'x-client-version': 'Chrome/JsCore/11.6.0/FirebaseCore-web',
                'x-firebase-gmpid': '1:976084784386:web:bb57c2b7c2642ce85b1e1b'
            };
            return await this.makeRequest('POST', url, payload, headers);
        }

        async getStatus(address, accessToken) {
            const url = `https://quant-api.opengradient.ai/api/activity/stats?address=${address}`;
            const headers = {
                'authorization': `Bearer ${accessToken}`,
                'content-type': 'application/json'
            };
            return await this.makeRequest('GET', url, null, headers);
        }

        async chatAI(context, message, accessToken) {
            const url = 'https://quant-api.opengradient.ai/api/agent/run';
            const payload = {
                context: context,
                message: { type: "user", message: message }
            };
            const headers = {
                'authorization': `Bearer ${accessToken}`,
                'content-type': 'application/json'
            };
            return await this.makeRequest('POST', url, payload, headers);
        }

        async nextTopicChatAI(context, accessToken) {
            try {
                const url = 'https://quant-api.opengradient.ai/api/agent/suggestions';
                const payload = {
                    context: context,
                    message: { type: "user", message: "" }
                };
                const headers = {
                    'authorization': `Bearer ${accessToken}`,
                    'content-type': 'application/json'
                };
                return await this.makeRequest('POST', url, payload, headers);
            } catch (error) {
                return {
                    suggestions: [this.getRandomChatTopic()]
                };
            }
        }

        createSignatureMessage(address) {
            const nonce = Date.now();
            const message = `bitquant.io wants you to sign in with your **blockchain** account:\n${address}\n\nURI: https://bitquant.io\nVersion: 1\nChain ID: solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp\nNonce: ${nonce}\nIssued At: ${new Date().toISOString()}`;
            return message;
        }

        signMessage(message, privateKey) {
            const keypair = Keypair.fromSecretKey(bs58.decode(privateKey));
            const messageBytes = new TextEncoder().encode(message);
            const signature = nacl.sign.detached(messageBytes, keypair.secretKey);
            const signatureBase58 = bs58.encode(signature);
            return signatureBase58;
        }

        getRandomChatTopic() {
            const topic = this.chatTopics[Math.floor(Math.random() * this.chatTopics.length)];
            return topic;
        }

        async sleep(ms) {
            return new Promise(resolve => setTimeout(resolve, ms));
        }

        async processAccount() {
            try {
                const keypair = Keypair.fromSecretKey(bs58.decode(this.privateKey));
                const address = keypair.publicKey.toString();

                this.sendMessage('status_update', {
                    status: 'running',
                    process: 'Checking whitelist...',
                    address: address
                });

                let accessToken = null;
                let status = null;
                let retryFromLogin = true;

                while (retryFromLogin) {
                    retryFromLogin = false;
                    
                    try {
                        // const whitelistResult = await this.checkWhitelist(address);
                        // if (!whitelistResult.allowed) {
                        //     this.sendMessage('complete', { reason: 'Not whitelisted', points: 0 });
                        //     return;
                        // }

                        this.sendMessage('status_update', {
                            status: 'running',
                            process: 'Authenticating...'
                        });

                        const message = this.createSignatureMessage(address);
                        const signature = this.signMessage(message, this.privateKey);
                        const authResult = await this.authWallet(address, message, signature);

                        const signResult = await this.accountSign(authResult.token);
                        await this.accountLookup(signResult.idToken);
                        const tokenResult = await this.getToken(signResult.refreshToken);
                        accessToken = tokenResult.access_token;

                        status = await this.getStatus(address, accessToken);
                        this.currentPoints = status.points || 0;

                        this.sendMessage('status_update', {
                            status: 'running',
                            process: `Daily: ${status.daily_message_count}/${status.daily_message_limit}`,
                            chatTotal: status.message_count,
                            points: this.currentPoints
                        });

                        const remainingChats = status.daily_message_limit - status.daily_message_count;
                        if (remainingChats <= 0) {
                            this.sendMessage('complete', { 
                                reason: 'Daily limit reached', 
                                points: this.currentPoints 
                            });
                            return;
                        }

                        let conversationHistory = [];
                        let context = {
                            conversationHistory: [],
                            address: address,
                            poolPositions: [],
                            availablePools: []
                        };

                        for (let i = 0; i < remainingChats; i++) {
                            try {
                                let chatMessage;
                                if (i === 0) {
                                    chatMessage = this.getRandomChatTopic();
                                } else {
                                    const suggestions = await this.nextTopicChatAI(context, accessToken);
                                    if (suggestions.suggestions && suggestions.suggestions.length > 0) {
                                        const randomIndex = Math.floor(Math.random() * suggestions.suggestions.length);
                                        chatMessage = suggestions.suggestions[randomIndex];
                                    } else {
                                        chatMessage = this.getRandomChatTopic();
                                    }
                                }

                                this.sendMessage('status_update', {
                                    status: 'running',
                                    process: `Chat: ${chatMessage.substring(0, 15)}...`,
                                    chatTotal: status.daily_message_count + i,
                                    points: this.currentPoints
                                });

                                const chatResponse = await this.chatAI(context, chatMessage, accessToken);
                                conversationHistory.push({ type: "user", message: chatMessage });
                                conversationHistory.push({ type: "assistant", message: chatResponse.message });

                                context.conversationHistory = conversationHistory;
                                if (chatResponse.pools) context.poolPositions = chatResponse.pools;
                                if (chatResponse.tokens) context.availablePools = chatResponse.tokens;

                                const updatedStatus = await this.getStatus(address, accessToken);
                                this.currentPoints = updatedStatus.points || 0;

                                if (i < remainingChats - 1) {
                                    await this.sleep(3000);
                                }
                            } catch (error) {
                                if (error.message === '403_RESTART_NEEDED') {
                                    this.sendMessage('status_update', {
                                        status: 'running',
                                        process: 'Restarting login due to 403...'
                                    });
                                    retryFromLogin = true;
                                    break;
                                } else {
                                    this.sendMessage('status_update', {
                                        status: 'running',
                                        process: `Error in chat ${i + 1}: ${error.message.substring(0, 15)}...`,
                                        points: this.currentPoints
                                    });
                                    await this.sleep(5000);
                                }
                            }
                        }

                        if (!retryFromLogin) {
                            this.sendMessage('status_update', {
                                chatTotal: status.daily_message_count + remainingChats,
                                points: this.currentPoints
                            });
                            this.sendMessage('complete', { 
                                reason: 'All chats completed',
                                points: this.currentPoints
                            });
                        }

                    } catch (error) {
                        if (error.message === '403_RESTART_NEEDED') {
                            this.sendMessage('status_update', {
                                status: 'running',
                                process: 'Restarting login due to 403...'
                            });
                            retryFromLogin = true;
                            await this.sleep(5000);
                        } else {
                            this.sendMessage('error', { error: error.message });
                            return;
                        }
                    }
                }

            } catch (error) {
                this.sendMessage('error', { error: error.message });
            }
        }
    }

    const worker = new WorkerBot(workerData);
    worker.processAccount();
}
