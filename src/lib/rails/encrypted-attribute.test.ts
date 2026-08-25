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
const key = deriveKey(DETERMINISTIC_KEY, SALT);

const SHORT_PLAINTEXT = '{"api_key":"KEY123","api_secret":"SEC456"}';
const SHORT_MESSAGE = {
  p: "jFlBRVkF5OPfu7/xLmbMxb2k/Tp4DPem6AsJH5ajmdft4MhsVGvbvEiv",
  h: { iv: "9HGKUhLFPQQ+YvUw", at: "AU8jH5oq6NHVd6+wlIzmDg==" },
};

/** 147 bytes — over the 140-byte threshold, so Rails deflates it and tags "c". */
const LONG_PLAINTEXT =
  '{"api_key":"KEY123","api_secret":"SEC456","v2_api_key":"TEST_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789padpadpadpad"}';
const LONG_MESSAGE = {
  p: "qtMJFtAZ+0TEwWF33DASRluLED455wyroDGB9EWMHbNYCgzr06MG2dknbCKVZJQDboxInrhyEQtqA4a11HkyLtvnU6hvZZU68PaHhz1zJoHG+JJrDQkj8JjkxPV4oZ+30NTCINdEhzFXH4bgDp/70nIKvy9IShz938wCXA==",
  h: { iv: "QzthloY2nj4e5lg1", at: "hQYXY0iM4GkfkH08p+2g9A==", c: true },
};

describe("deriveKey", () => {
  it("derives the key Rails derives", () => {
    // ActiveSupport::KeyGenerator's SHA1 default, 2**16 iterations.
    expect(key.toString("hex")).toBe(
      "eddda6511100bb98e6bbc42ceedbff39cd56825f0f6f4d52299d2cdc1922ccd1",
    );
  });
});

describe("encryptMessage", () => {
  it("produces byte-identical output to Rails for a short value", () => {
    expect(encryptMessage(SHORT_PLAINTEXT, key)).toEqual(SHORT_MESSAGE);
  });

  it("deflates and tags anything over the 140-byte threshold, as Rails does", () => {
    expect(encryptMessage(LONG_PLAINTEXT, key)).toEqual(LONG_MESSAGE);
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
