const https = require('https');
const axios = require('axios');

class whatsappClient {
    constructor(params) {
        this.BASE_URI = 'http://192.168.178.180:8000';
        this.timeout = parseInt(params.timeout) || 5000;

        this.deviceId = params.deviceId;

        this._isDebugMode = params.debug || false;

        this.axiosClient = axios.create({
            httpsAgent: new https.Agent({
                rejectUnauthorized: false
            }),
            timeout: this.timeout
        });
    }


    async addDevice() {
        const apiUrl = `${this.BASE_URI}/addDevice`;

        const params = new URLSearchParams({
            clientID: this.deviceId
        }).toString(); 

        const res = await this.axiosClient.post(`${apiUrl}?${params}`);

        if (res.status === 200) {
            return res.data;
        }

        return false;
    }

    async sendPresenceUpdate(recipient, type) {
        const apiUrl = `${this.BASE_URI}/sendPresenceUpdate`;

        const params = new URLSearchParams({
            clientID: this.deviceId,
            recipient,
            type
        }).toString(); 

        const res = await this.axiosClient.post(`${apiUrl}?${params}`);

        if (res.status === 200) {
            return res.data;
        }

        return false;
    }

    async sendText(recipient, message) {
        const apiUrl = `${this.BASE_URI}/sendText`;

        const params = new URLSearchParams({
            clientID: this.deviceId,
            recipient,
            message
        }).toString(); 

        const res = await this.axiosClient.post(`${apiUrl}?${params}`);

        if (res.status === 200) {
            return res.data;
        }

        return false;
    }

    async sendMedia(recipient, fileUrl, message) {
        const apiUrl = `${this.BASE_URI}/sendMedia`;

        const params = new URLSearchParams({
            clientID: this.deviceId,
            recipient,
            fileUrl,
            message
        }).toString(); 

        const res = await this.axiosClient.post(`${apiUrl}?${params}`);

        if (res.status === 200) {
            return res.data;
        }

        return false;
    }

    async sendFile(recipient, fileUrl) {
        const apiUrl = `${this.BASE_URI}/sendFile`;

        const params = new URLSearchParams({
            clientID: this.deviceId,
            recipient,
            fileUrl
        }).toString(); 

        const res = await this.axiosClient.post(`${apiUrl}?${params}`);

        if (res.status === 200) {
            return res.data;
        }

        return false;
    }

    async sendLocation(recipient, lat, lon, message) {
        const apiUrl = `${this.BASE_URI}/sendLocation`;

        const params = new URLSearchParams({
            clientID: this.deviceId,
            recipient,
            lat, 
            lon, 
            message
        }).toString(); 

        const res = await this.axiosClient.post(`${apiUrl}?${params}`);

        if (res.status === 200) {
            return res.data;
        }

        return false;
    }
}

module.exports = whatsappClient;
