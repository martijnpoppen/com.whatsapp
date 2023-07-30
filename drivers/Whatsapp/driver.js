const Homey = require('homey');
const path = require("path");
const { BaileysClass } = require("@bot-wa/bot-wa-baileys");
const { GetGUID } = require('../../lib/helpers');

module.exports = class mainDriver extends Homey.Driver {
    onInit() {
        this.homey.app.log('[Driver] - init', this.id);
        this.homey.app.log(`[Driver] - version`, Homey.manifest.version);
    }

    async onPair(session) {
        this.type = 'pair';
        this.setPairingSession(session);
    }

    async onRepair(session) {
        this.type = 'repair';
        this.setPairingSession(session);
    }

    async setPairingSession(session) {
        this.consent = false;
        this.guid = GetGUID();

        this.WhatsappClient = new BaileysClass({
            name: this.guid,
            dir: `${path.resolve(__dirname, '../../userdata')}/`,
            plugin: false
        });

        this.WhatsappClient.on("qr", (qr) => {
            this.homey.app.log(`[Driver] ${this.id} - got QR`, qr);

            this.qr = qr;

            if(this.consent) {
                session.showView('whatsapp_qr');
            }
        });

        this.WhatsappClient.once("ready", () => {
            this.homey.app.log(`[Driver] ${this.id} - ready`);

            session.showView('list_devices');
        });

        session.setHandler('showView', async (view) => {
            if (view === 'whatsapp_qr') {
                await session.emit('qr', this.qr);
            }

            if (view === 'loading') {
                this.consent = true;

                if(this.qr) {
                    session.showView('whatsapp_qr');
                }
            }
        });

        session.setHandler('list_devices', async () => {
            this.WhatsappClient = null;

            this.results = [{
                name: `Whatsapp`,
                data: {
                    id: this.guid
                }
            }];

            this.homey.app.log(`[Driver] ${this.id} - Found devices - `, this.results);

            return this.results;
        });
    }
};
