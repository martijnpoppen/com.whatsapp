const https = require('https');
const axios = require('axios');

class textmebot {
    constructor(params) {
        this.BASE_URI = 'https://api.textmebot.com';
        this.timeout = parseInt(params.timeout) || 5000;

        this.apiKey = params.apiKey;

        this._isDebugMode = params.debug || false;

        this.axiosClient = axios.create({
            httpsAgent: new https.Agent({
                rejectUnauthorized: false
            }),
            timeout: this.timeout
        });
    }

    async newUserEmail(email) {
        const apiUrl = `${this.BASE_URI}/whatsapp/add_prime_email.php`;

        const params = new URLSearchParams({
            email: email,
            id: 10649,
            source: 'homey'
        }).toString();

        const req = await this.axiosClient.get(`${apiUrl}?${params}`);

        if (req.status === 200) {
            if (this._isDebugMode) console.log(req.data);
            return true;
        }

        return false;
    }

    async connectPhoneNumberToApiKey(phone, apikey = this.apiKey) {
        const apiUrl = `${this.BASE_URI}/crud/addphone_AgregarNuevo.php`;

        const params = new URLSearchParams({
            phone,
            apikey,
            source: 'homey'
        }).toString(); 

        const req = await this.axiosClient.post(`${apiUrl}?${params}`);

        if (req.status === 200) {
            // if (this._isDebugMode) console.log(req.data);
            return true;
        }

        return false;
    }

    async disconnectPhoneNumberToApiKey() {
        const apiUrl = `${this.BASE_URI}/crud/addphone_BorrarRegistro.php`;

        const params = new URLSearchParams({
            apikey: this.apiKey,
            source: 'homey'
        }).toString();

        const req = await this.axiosClient.get(`${apiUrl}?${params}`);

        if (req.status === 200) {
            // if (this._isDebugMode) console.log(req.data);
            return true;
        }

        return false;
    }

    async sendTextMessage(recipient, message, fileUrl = null, fileType) {
        const apiUrl = `${this.BASE_URI}/send.php`;

        const params = new URLSearchParams({
            apikey: this.apiKey,
            recipient: recipient,
            text: message,
            ...(fileUrl && { [fileType]: fileUrl }),
            json: 'yes',
            source: 'homey'
        }).toString();

        const req = await this.axiosClient.get(`${apiUrl}?${params}`);

        if (req.status === 200) {
            if (this._isDebugMode) console.log(req.data);
            return true;
        }

        return false;
    }

    async getGroupId(invitationCode) {
        try {
            const apiUrl = `${this.BASE_URI}/send.php`;

            const params = new URLSearchParams({
                apikey: this.apiKey,
                group_info: invitationCode,
                json: 'yes',
                source: 'homey'
            }).toString();
    
            const req = await this.axiosClient.get(`${apiUrl}?${params}`);
    
            if (req.status === 200) {
                if (this._isDebugMode) console.log(req.data);
                return req.data && req.data.group_id;
            }
    
            return false;
        } catch (error) {
            return false;
        }
       
    }

    async createWebhook(webhookUrl) {
        const apiUrl = `${this.BASE_URI}/crud/webhook_add.php`;

        const params = new URLSearchParams({
            apikey: this.apiKey,
            webhook: webhookUrl ? webhookUrl : "",
            json: 'yes',
            source: 'homey'
        }).toString();

        const req = await this.axiosClient.get(`${apiUrl}?${params}`);

        if (req.status === 200) {
            if (this._isDebugMode) console.log(req.data);
            return req.data && req.data.group_id;
        }

        return false;
    }

    async deleteWebhook() {
        const apiUrl = `${this.BASE_URI}/crud/webhook_delete.php`;

        const params = new URLSearchParams({
            apikey: this.apiKey,
            json: 'yes',
            source: 'homey'
        }).toString();

        const req = await this.axiosClient.get(`${apiUrl}?${params}`);

        if (req.status === 200) {
            if (this._isDebugMode) console.log(req.data);
            return req.data && req.data.group_id;
        }

        return false;
    }
}

module.exports = textmebot;
