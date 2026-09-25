// A complete reference implementation of the transport contract in
// notifyTransport.js.
//
// It exists so the deliver / fail / retry / give-up paths can be run end to
// end without an email account, an SMS gateway or a WhatsApp number. Nothing
// here leaves the process: a "sent" message is appended to an array in memory
// and that is the whole of it.
//
// It reports success on command, which is exactly what a notification must
// never do in front of someone who is relying on being told, so it is refused
// outside test and development twice over: by config/env.js at boot and again
// by the registry on every lookup.

// Every message this transport was asked to send, oldest first. A test reads
// it to assert that the delivery path ran and carried the right text — the
// notification row alone cannot prove that, because a row marked DELIVERED is
// exactly what a transport that silently did nothing would also leave behind.
const sent = [];

// recipientId -> answers. Consumed in order; the LAST answer repeats for ever.
//
// One mechanism covers both things a test needs. A standing behaviour is a
// one-element script, and a sequence is a several-element one — so a test that
// means "fails once, then works" does not have to know how many times the
// scheduler will call, and a test that means "always refuses" does not have to
// supply an answer per attempt.
const scripted = new Map();

export const testTransportSent = () => sent.slice();

export const scriptTestTransport = (recipientId, answers) => {
  scripted.set(recipientId, Array.isArray(answers) ? [...answers] : [answers]);
};

export const clearTestTransport = () => {
  sent.length = 0;
  scripted.clear();
};

const nextAnswer = (recipientId) => {
  const queue = scripted.get(recipientId);
  if (!queue || queue.length === 0) return { delivered: true };
  return queue.length === 1 ? queue[0] : queue.shift();
};

export const testNotifyTransport = {
  name: 'test',

  async send({ notificationId, recipientId, channel, title, body, attempt }) {
    const answer = nextAnswer(recipientId);

    // Recorded before the answer is examined. A test asserting "we gave up
    // after two attempts" needs the refused attempts in here too, otherwise
    // the record would only ever show the successes and could not tell a
    // transport that refused twice from one that was never called.
    sent.push({ notificationId, recipientId, channel, title, body, attempt, at: new Date() });

    if (answer.delivered === false) return answer;

    return {
      delivered: true,
      // A script may name the reference it wants, so a test can assert that
      // the value the transport returned is the value that reached the row
      // rather than one this function happened to make up. Only when it does
      // not is a reference synthesised — derived from the notification and the
      // attempt, so a retry is distinguishable from the first try and a
      // duplicate send is visible rather than merely plausible.
      providerRef: answer.providerRef ?? `testmsg_${notificationId}_${attempt}`,
    };
  },
};
