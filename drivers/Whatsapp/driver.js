const Homey = require('homey');
const path = require("path");
const fs = require('fs-extra');
const { BaileysClass } = require("@bot-wa/bot-wa-baileys");

const { GetGUID, sleep } = require('../../lib/helpers');


module.exports = class mainDriver extends Homey.Driver {
    onInit() {
        this.homey.app.log('[Driver] - init', this.id);
        this.homey.app.log(`[Driver] - version`, Homey.manifest.version);
        this.WhatsappClients = [];

        const devices = this.getDevices();

        devices.forEach(async (device) => {
            const deviceObject = device.getData();
            await this.setWhatsappClient(deviceObject.id);
            await this.setWhatsappClientListeners(device, deviceObject.id);
        });
    }

    setWhatsappClient(deviceId,) {
        this.WhatsappClients[deviceId] = new BaileysClass({
            name: deviceId,
            dir: `${path.resolve(__dirname, '/userdata/')}/`,
            plugin: false
        });

        return this.WhatsappClients[deviceId];
    }

    setWhatsappClientListeners(device = null, deviceId) {
        this.WhatsappClients[deviceId].once('qr', (qr) => {
            

            this.qr = qr;

            if(device) {
                this.homey.app.log(`[Device] ${device.getName()} - listenToWhatsappEvents - QR`);
                device.setUnavailable(`Repair device and Scan QR code to connect`);
            } else {
                this.homey.app.log(`[Driver] - listenToWhatsappEvents - QR`);
            }
        });

        this.WhatsappClients[deviceId].once('ready', () => {
            

            this.ready = true;

            if(device) {
                this.homey.app.log(`[Device] ${device.getName()} - listenToWhatsappEvents - Ready`);
                device.setAvailable();
            } else {
                this.homey.app.log(`[Driver] - listenToWhatsappEvents - Ready`);
            }
        });

        this.WhatsappClients[deviceId].once('auth_failure', (error) => {
            

            if(device) {
                this.homey.app.log(`[Device] ${device.getName()} - listenToWhatsappEvents - auth_failure`);
                device.setUnavailable(error);
            } else {
                this.homey.app.log(`[Driver]- listenToWhatsappEvents - auth_failure`);
            }
        });
    }

    async onPair(session) {
        this.type = 'pair';
        this.device = null;

        this.setPairingSession(session);
    }

    async onRepair(session, device) {
        this.type = 'repair';
        this.device = device;

        this.setPairingSession(session);
    }

    async setPairingSession(session) {
        this.consent = false;
        this.deviceObject = this.device && this.device.getData();
        this.guid = this.device ? this.deviceObject.id : GetGUID();

        if(this.type === 'repair') {
            this.device.removeWhatsappClient();

            this.homey.app.log(`[Driver] ${this.id} - REPAIR - remove all`);
            fs.rmSync(`${path.resolve(__dirname, '/userdata/')}/${this.guid}_sessions/creds.json`, { recursive: true, force: true })
            fs.rmSync(`${path.resolve(__dirname, '/userdata/')}/${this.guid}_sessions/baileys_store.json`, { recursive: true, force: true })

            await sleep(2000);
        }

        await this.setWhatsappClient(this.guid);
        await this.listenToWhatsappEvents(null, this.guid);

        this.onPollInterval = setInterval(() => {
            if(this.qr) {
                this.qr = null;
                session.showView('whatsapp_qr');
            }

            if(this.ready) {
                this.ready = null;
                session.showView('loading2');
            }
        }, 200);

        session.setHandler('showView', async (view) => {
            this.homey.app.log(`[Driver] ${this.id} - currentView:`, { view, type: this.type });

            if (view === 'whatsapp_qr') {
                await session.emit('qr', this.qr);
            }

            if (view === 'loading') {
                this.consent = true;
            }

            if (view === 'loading2') {
                clearInterval(this.onPollInterval);

                this.results = [{
                    name: `Whatsapp`,
                    data: {
                        id: this.guid
                    }
                }];
    
                this.homey.app.log(`[Driver] ${this.id} - Found devices - `, this.results);

                if(this.results.length && this.type === 'repair') {
                    if(this.device) {
                        this.device.setWhatsappClient();
                    }
                    session.showView('done');
                } else {
                    session.showView('list_devices');
                }
            }
        });

        session.setHandler('list_devices', async () => {            
            return this.results;
        });
    }
};
