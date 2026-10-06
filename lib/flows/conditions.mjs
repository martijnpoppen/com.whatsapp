import { parseGroupInvite } from '../helpers/index.mjs';

const normalize = (str) => str?.trim().toLowerCase();

// Condition cards are app-scoped: homey.flow.getConditionCard() hands back one
// shared card object for the whole app, so its run listener may only be
// registered once. This used to live in Device.onInit, which meant adding a
// second WhatsApp device re-registered every listener on the same eight cards
// and Homey rejected it as already registered. Registered once from App.onInit
// now, the same way the action cards always were.
const init = async function (homey) {
    // One pre-formatted line per evaluation. Passing the state object made
    // console expand it over ~11 lines, and this fires for every condition in
    // every flow on every message — five evaluations of one message filled 55
    // lines of a diagnostics report. Keep enough to debug a condition that
    // didn't match; drop the rest.
    const digest = (state) => {
        if (!state) return '';
        const text = typeof state.text === 'string' ? state.text : '';
        return [
            state.from && `from=${state.from}`,
            state.fromNumber && `num=${state.fromNumber}`,
            `text=${JSON.stringify(text.length > 40 ? `${text.slice(0, 40)}…` : text)}`,
            state.group ? 'group' : null,
            state.hasImage ? 'image' : null
        ]
            .filter(Boolean)
            .join(' ');
    };

    const register = (id, listener) => {
        const card = homey.flow.getConditionCard(id);
        card.registerRunListener(async (args, state) => {
            const result = await listener(args, state);
            homey.app.log(`[Conditions] [${id}] result=${result} device=${args.device?.getName()} ${digest(state)}`);
            return result;
        });
    };

    register('text_condition', (args, state) => !!state.text && normalize(state.text) === normalize(args.text_input));

    register('text_contains_condition', (args, state) => !!state.text && normalize(state.text).includes(normalize(args.text_input)));

    register('text_starts_with_condition', (args, state) => !!state.text && normalize(state.text).startsWith(normalize(args.text_input)));

    register('from_condition', (args, state) => !!state.from && normalize(state.from) === normalize(args.from_input));

    register('from_number_condition', (args, state) => !!state.fromNumber && normalize(state.fromNumber) === normalize(args.from_input));

    register('group_condition', (args, state) => state.group === true);

    register('group_code_condition', (args, state) => state.groupCode === parseGroupInvite(args.group_code_input));

    register('image_condition', (args, state) => state.hasImage === true);
};

export default {
    init
}
