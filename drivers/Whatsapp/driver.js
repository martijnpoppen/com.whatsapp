const Homey = require('homey');
const WhatsappClient = require('../../lib/textmebot/whatsapp');

module.exports = class mainDriver extends Homey.Driver {
    onInit() {
        this.homey.app.log('[Driver] - init', this.id);
        this.homey.app.log(`[Driver] - version`, Homey.manifest.version);

        this.homey.app.setDevices(this.getDevices());
    }

    async onPair(session) {
        this.config = {};
        this.WhatsappClient = new WhatsappClient({});

        session.setHandler('showView', async (view) => {
            if (view === 'whatsapp_qr') {
                await session.emit('phone', this.config.phone.replace('+', ''));
            }
        });

        session.setHandler('set_email', async ({ email }) => {
            this.config.email = email;
            this.WhatsappClient.newUserEmail(email);

            return true;
        });

        session.setHandler('set_apikey', async ({ apikey }) => {
            this.config.apiKey = apikey;

            return true;
        });

        session.setHandler('set_phone', async ({ phone }) => {
            this.config.phone = phone;
            this.WhatsappClient.connectPhoneNumberToApiKey(phone, this.config.apiKey);

            return true;
        });

        session.setHandler('list_devices', async () => {
            this.results = [];
            this.homey.app.log(`[Driver] ${this.id} - this.config`, this.config);
            this.results.push({
                name: `Whatsapp`,
                data: {
                    id: this.config.apiKey
                },
                settings: {
                    ...this.config
                }
            });

            this.homey.app.log(`[Driver] ${this.id} - Found devices - `, this.results);

            return this.results;
        });
    }
};
