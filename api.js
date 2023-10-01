module.exports = {
    async store({ homey, body }) {
        const driver = homey.drivers.getDriver('Whatsapp');
        const devices = driver.getDevices();
        const { data, homeyId, clientId } = body || {};
        const {type, key, value} = data || {};

        const device = devices.find((d) => {
            const deviceId = d.getData().id;
            return deviceId === `${homeyId}_${clientId}`;
        });

        let response = { success: false, message: 'Device not found' };

        if (device) {
            switch (type) {
                case 'SET':
                    await device.setStoreValue(key, value);
                    response = { success: true, message: 'Data stored' };
                    break;

                case 'GET':
                    const data = await device.getStoreValue(key);
                    response = { success: true, message: data };
                    break;

                case 'UNSET':
                    await device.unsetStoreValue(key);
                    response = { success: true, message: 'Data Unset' };
                case 'UNSET_ALL':
                    const storeData = device.getStore();
                    Object.keys(storeData).forEach((storeKey) => {
                        if (storeKey.includes(key)) {
                            device.unsetStoreValue(storeKey);
                        }
                    });
                    response = { success: true, message: 'Data removed' };
                    break;

                default:
                    response = { success: false, message: `Type ${type} not found` };
                    break;

            }
        }
        return response;
    }
};
