/**
 * Active Record Encryption compatibility.
 *
 * The vectors below were produced by ActiveRecord::Encryption itself
 * (activerecord 8.1.3.1) with the keys config/environments/test.rb configures,
 * so a change that breaks interoperability with the running Rails app fails
 * here rather than in production with an unreadable credentials column.
 *
 *   det  = ActiveRecord::Encryption::DeterministicKeyProvider.new(deterministic_key)
 *   enc  = ActiveRecord::Encryption::Encryptor.new
 *   enc.encrypt(plain, key_provider: det, cipher_options: { deterministic: true })
 */

import { describe, it, expect } from "vitest";

import {
  decryptMessage,
  deriveKey,
  encryptMessage,
  isEncryptedMessage,
  RailsEncryptionError,
} from "./encrypted-attribute";

const DETERMINISTIC_KEY = "test_deterministic_key_0123456789";
const SALT = "test_key_derivation_salt_01234567";
/**
 * The vectors below were generated with the SHA1 derivation, so they are
 * decrypted with it explicitly. That is not the app's default any more: Rails
 * 7.1's framework defaults moved `hash_digest_class` to SHA256 and
 * config/application.rb declares `load_defaults 8.0`, so the running app
 * derives with SHA256 and every row in production was written under it.
 * Deriving with the wrong one yields a valid-looking 32-byte key that fails GCM
 * authentication on every row — which is precisely what happened in production
 * (STU2-3293), and what these tests did NOT catch, because the vectors and the
 * implementation agreed with each other rather than with the deployed Rails app.
 */
const key = deriveKey(DETERMINISTIC_KEY, SALT, "sha1");

const SHORT_PLAINTEXT = '{"api_key":"KEY123","api_secret":"SEC456"}';
const SHORT_MESSAGE = {
  p: "jFlBRVkF5OPfu7/xLmbMxb2k/Tp4DPem6AsJH5ajmdft4MhsVGvbvEiv",
  h: { iv: "9HGKUhLFPQQ+YvUw", at: "AU8jH5oq6NHVd6+wlIzmDg==" },
};

/**
 * 147 bytes — over the 140-byte threshold, so Rails deflates it and tags "c".
 *
 * This vector is used to prove we can READ what Rails wrote. It is deliberately
 * not used to prove we write the same bytes: see the note in the test below.
 */
const LONG_PLAINTEXT =
  '{"api_key":"KEY123","api_secret":"SEC456","v2_api_key":"TEST_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789padpadpadpad"}';
const LONG_MESSAGE = {
  p: "qtMJFtAZ+0TEwWF33DASRluLED455wyroDGB9EWMHbNYCgzr06MG2dknbCKVZJQDboxInrhyEQtqA4a11HkyLtvnU6hvZZU68PaHhz1zJoHG+JJrDQkj8JjkxPV4oZ+30NTCINdEhzFXH4bgDp/70nIKvy9IShz938wCXA==",
  h: { iv: "QzthloY2nj4e5lg1", at: "hQYXY0iM4GkfkH08p+2g9A==", c: true },
};

/**
 * Restores an environment variable, including to "unset".
 *
 * `process.env.X = undefined` stores the literal string "undefined", so a naive
 * save/restore leaves a variable that began unset looking configured — and a
 * later test in the same process then derives a key against the word
 * "undefined" instead of failing as it should.
 */
function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe("deriveKey", () => {
  it("derives the SHA1 key, for an app still on 6.1 framework defaults", () => {
    expect(deriveKey(DETERMINISTIC_KEY, SALT, "sha1").toString("hex")).toBe(
      "eddda6511100bb98e6bbc42ceedbff39cd56825f0f6f4d52299d2cdc1922ccd1",
    );
  });

  it("defaults to SHA256, which is what load_defaults 7.1+ derives with", () => {
    // A LITERAL, not a comparison against deriveKey(..., "sha256") — that would
    // assert only that the default equals itself and would keep passing if the
    // default went back to SHA1, which is the failure this whole PR exists to
    // fix. PBKDF2-HMAC-SHA256 is fully specified, so this value is fixed by the
    // standard rather than by anything in this file.
    expect(deriveKey(DETERMINISTIC_KEY, SALT).toString("hex")).toBe(
      "bd744b4cf47f1679c683084cfadc1c360570b0bd147a6fea56ee2d2ead084c08",
    );
  });
});

/**
 * The DEFAULT paths — no explicit key — which are the ones production uses and
 * the ones nothing pinned before. Every test above hands in a key, so they all
 * went on passing while the deployed service could not read a single row.
 */
describe("the default key path", () => {
  const withEnv = <T,>(run: () => T): T => {
    const before = {
      k: process.env.ACTIVE_RECORD_ENCRYPTION_DETERMINISTIC_KEY,
      s: process.env.ACTIVE_RECORD_ENCRYPTION_KEY_DERIVATION_SALT,
    };
    process.env.ACTIVE_RECORD_ENCRYPTION_DETERMINISTIC_KEY = DETERMINISTIC_KEY;
    process.env.ACTIVE_RECORD_ENCRYPTION_KEY_DERIVATION_SALT = SALT;
    try {
      return run();
    } finally {
      restoreEnv("ACTIVE_RECORD_ENCRYPTION_DETERMINISTIC_KEY", before.k);
      restoreEnv("ACTIVE_RECORD_ENCRYPTION_KEY_DERIVATION_SALT", before.s);
    }
  };

  it("encrypts under SHA256, so what it writes is what the Rails app reads", () => {
    withEnv(() => {
      const message = encryptMessage(SHORT_PLAINTEXT);
      // Byte-identical to encrypting with the SHA256 key explicitly, and NOT to
      // the SHA1 vector. Reverting the default to SHA1 fails here.
      expect(message).toEqual(
        encryptMessage(SHORT_PLAINTEXT, deriveKey(DETERMINISTIC_KEY, SALT, "sha256")),
      );
      expect(message).not.toEqual(SHORT_MESSAGE);
    });
  });

  it("reads a SHA256 row without being told which digest to use", () => {
    withEnv(() => {
      const message = encryptMessage(
        SHORT_PLAINTEXT,
        deriveKey(DETERMINISTIC_KEY, SALT, "sha256"),
      );
      expect(decryptMessage(message)).toBe(SHORT_PLAINTEXT);
    });
  });

  it("falls back to SHA1 for a row written under 6.1 defaults", () => {
    // Exercises the fallback itself: this vector authenticates ONLY under SHA1,
    // and no key is passed. Dropping "sha1" from KEY_DIGESTS fails here.
    withEnv(() => {
      expect(decryptMessage(SHORT_MESSAGE)).toBe(SHORT_PLAINTEXT);
    });
  });

  it("still refuses a truncated auth tag once, before trying any key", () => {
    withEnv(() => {
      expect(() =>
        decryptMessage({ ...SHORT_MESSAGE, h: { ...SHORT_MESSAGE.h, at: "AAAA" } }),
      ).toThrow(RailsEncryptionError);
    });
  });

  it("throws rather than returning plausible plaintext when no digest authenticates", () => {
    withEnv(() => {
      const tampered = {
        ...SHORT_MESSAGE,
        p: Buffer.from("not the ciphertext this tag covers").toString("base64"),
      };
      expect(() => decryptMessage(tampered)).toThrow();
    });
  });
});

describe("encryptMessage", () => {
  it("produces byte-identical output to Rails for a short value", () => {
    expect(encryptMessage(SHORT_PLAINTEXT, key)).toEqual(SHORT_MESSAGE);
  });

  it("deflates and tags anything over the 140-byte threshold, as Rails does", () => {
    const message = encryptMessage(LONG_PLAINTEXT, key);

    expect(message.h.c).toBe(true);
    // NOT compared byte-for-byte with Rails: DEFLATE output depends on the zlib
    // build, so Ruby's bytes and Node's differ (and macOS's and Linux's differ
    // from each other — CI caught exactly that). What has to hold is that the
    // message is still readable, which is asserted below in both directions.
    expect(decryptMessage(message, key)).toBe(LONG_PLAINTEXT);
  });

  it("is deterministic — the same clear text always gives the same message", () => {
    expect(encryptMessage(SHORT_PLAINTEXT, key)).toEqual(
      encryptMessage(SHORT_PLAINTEXT, key),
    );
  });
});

describe("decryptMessage", () => {
  it("reads a message Rails wrote", () => {
    expect(decryptMessage(SHORT_MESSAGE, key)).toBe(SHORT_PLAINTEXT);
  });

  it("inflates a compressed message Rails wrote", () => {
    expect(decryptMessage(LONG_MESSAGE, key)).toBe(LONG_PLAINTEXT);
  });

  it("refuses a truncated auth tag rather than trusting it", () => {
    expect(() =>
      decryptMessage({ ...SHORT_MESSAGE, h: { ...SHORT_MESSAGE.h, at: "AA==" } }, key),
    ).toThrow(RailsEncryptionError);
  });

  it("refuses a tampered payload", () => {
    const tampered = { ...SHORT_MESSAGE, p: encryptMessage("something else", key).p };
    expect(() => decryptMessage(tampered, key)).toThrow();
  });
});

describe("isEncryptedMessage", () => {
  it("recognises the envelope", () => {
    expect(isEncryptedMessage(SHORT_MESSAGE)).toBe(true);
  });

  it("does not mistake a plain settings hash for one", () => {
    expect(isEncryptedMessage({ api_key: "KEY123" })).toBe(false);
    expect(isEncryptedMessage(null)).toBe(false);
  });
});
