/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */
import * as assert from 'assert';
import { dirname } from 'path';

import {
	assertThrowsHttp,
	getFirstLayerDigestFromManifest,
	hashAndCount,
} from './util';

import { RegistryClientV2 } from '../lib/registry-client-v2';
import { parseRepo, MEDIATYPE_MANIFEST_V2 } from '../lib/common';
import { ManifestV2 } from '../lib/types';

// --- globals

const REPO = 'quay.io/coreos/etcd';
const repo = parseRepo(REPO);
// Note: Not using TAG='latest' as a workaround for
// <https://github.com/joyent/node-docker-registry-client/issues/12>.
const TAG = 'v3.5.0';

// --- Tests

jest.setTimeout(10 * 1000);

it('v2 quay.io / RegistryClientV2', () => {
	const client = new RegistryClientV2({ repo });
	assert.equal(client.version, 2);
});

it('v2 quay.io / supportsV2', async () => {
	const client = new RegistryClientV2({ repo });
	const supportsV2 = await client.supportsV2();
	assert.equal(supportsV2, true);
});

it('v2 quay.io / ping', async () => {
	const client = new RegistryClientV2({ repo });
	const res = await client.ping();
	assert.equal(res.status, 401);
	assert(res.headers.get('www-authenticate'));
	assert.equal(
		res.headers.get('docker-distribution-api-version'),
		'registry/2.0',
	);
});

/*
 * Example expected output:
 *  {
 *      "name": "library/alpine",
 *      "tags": [ "2.6", "2.7", "3.1", "3.2", "edge", "latest" ]
 *  }
 */
it('v2 quay.io / listTags', async () => {
	const client = new RegistryClientV2({ repo });
	const tag = 'latest'; // pagination is broken so this might need to change over time
	const tags = await client.listTags();
	assert.equal(tags.name, repo.remoteName);
	assert(
		tags.tags.indexOf(tag) !== -1,
		'tag "' + tag + '" in listTags:' + JSON.stringify(tags),
	);
});

/*
 *  {
 *      "name": <name>,
 *      "tag": <tag>,
 *      "fsLayers": [
 *         {
 *            "blobSum": <tarsum>
 *         },
 *         ...
 *      ],
 *      "history": <v1 images>,
 *      "signature": <JWS>
 *  }
 */
let _manifest: ManifestV2 | null;
let _manifestDigest: string | null;
it('v2 quay.io / getManifest', async () => {
	const client = new RegistryClientV2({ repo });
	const { manifest, resp } = await client.getManifest({ ref: TAG });
	_manifestDigest = resp.headers.get('docker-content-digest');
	assert(manifest);
	assert.equal(manifest.schemaVersion, 2);
	assert(manifest.schemaVersion === 2);
	assert.equal(manifest.mediaType, MEDIATYPE_MANIFEST_V2);
	assert(manifest.mediaType === MEDIATYPE_MANIFEST_V2);
	_manifest = manifest ?? null;
	assert(manifest.layers);
	assert.equal(
		manifest.layers?.[0].mediaType,
		'application/vnd.docker.image.rootfs.diff.tar.gzip',
	);
});

it('v2 quay.io / getManifest (by digest)', async () => {
	if (!_manifestDigest || !_manifest) {
		throw new Error('cannot test');
	}
	const client = new RegistryClientV2({ repo });
	const { manifest } = await client.getManifest({ ref: _manifestDigest });
	assert(manifest);
	assert.equal(_manifest.schemaVersion, manifest.schemaVersion);
	assert(manifest.schemaVersion === 2);
	assert(manifest.mediaType === MEDIATYPE_MANIFEST_V2);
	assert.equal(_manifest.mediaType, manifest.mediaType);
	assert.equal(_manifest.config.digest, manifest.config.digest);
	assert.equal(_manifest.layers?.[0].digest, manifest.layers[0].digest);
});

it('v2 quay.io / getManifest (unknown tag)', async () => {
	const client = new RegistryClientV2({ repo });
	await assertThrowsHttp(async () => {
		await client.getManifest({ ref: 'unknowntag' });
	}, 404);
});

it('v2 quay.io / getManifest (unknown repo)', async () => {
	const client = new RegistryClientV2({
		name: dirname(REPO) + '/unknownreponame',
		// log: log
	});
	await assertThrowsHttp(async () => {
		await client.getManifest({ ref: 'latest' });
	}, 401);
});

it('v2 quay.io / getManifest (bad username/password)', async () => {
	const client = new RegistryClientV2({
		repo,
		username: 'fredNoExistHere',
		password: 'fredForgot',
		// log: log
	});
	await assertThrowsHttp(async () => {
		await client.getManifest({ ref: 'latest' });
	}, 401);
});

it('v2 quay.io / headBlob', async () => {
	if (!_manifest) {
		throw new Error('cannot test');
	}
	const client = new RegistryClientV2({ repo });
	const digest = getFirstLayerDigestFromManifest(_manifest);
	const ress = await client.headBlob({ digest });
	assert(ress);
	assert(Array.isArray(ress));
	const first = ress[0];
	assert(first.status === 200 || first.status === 307);
	assert.equal(first.headers.get('docker-content-digest'), digest);

	// Docker-Distribution-Api-Version header:
	// docker.io includes this header here, quay.io does not.
	// assert.equal(first.headers.get('docker-distribution-api-version'),
	//    'registry/2.0');

	const last = ress[ress.length - 1];
	assert(last);
	assert.equal(last.status, 200);

	// Content-Type:
	// - docker.io gives 'application/octet-stream', which is what
	//   I'd expect for the GET response at least.
	// - quay.io current v2 support gives: 'text/html; charset=utf-8'
	// if (!SKIP_QUAY_IO_BUGLETS) {
	assert.equal(last.headers.get('content-type'), 'application/octet-stream');
	// }

	assert(last.headers.get('content-length'));
});

it('v2 quay.io / headBlob (unknown digest)', async () => {
	const client = new RegistryClientV2({ repo });

	await assertThrowsHttp(async () => {
		await client.headBlob({ digest: 'cafebabe' });
	}, 405);
	// - docker.io gives 404, which is what I'd expect
	// - quay.io gives 405 (Method Not Allowed). Hrm.
	// The spec doesn't specify:
	// https://docs.docker.com/registry/spec/api/#existing-layers

	// docker.io includes this header here, quay.io does not.
	// assert.equal(resp.headers.get('docker-distribution-api-version'),
	//    'registry/2.0');
});

it('v2 quay.io / createBlobReadStream', async () => {
	if (!_manifestDigest || !_manifest) {
		throw new Error('cannot test');
	}
	const client = new RegistryClientV2({ repo });
	const digest = _manifest.layers[0].digest;
	const { ress, stream } = await client.createBlobReadStream({ digest });
	assert(ress, 'got responses');
	assert(Array.isArray(ress), 'ress is an array');

	const first = ress[0];
	assert(
		first.status === 200 || first.status === 307 || first.status === 302,
		`createBlobReadStream first res statusCode is 200 or 307, was ${first.status}`,
	);
	if (first.headers.get('docker-content-digest')) {
		assert.equal(first.headers.get('docker-content-digest'), digest);
	}
	// assert.equal(first.headers.get('docker-distribution-api-version'), 'registry/2.0');

	const last = ress.slice(-1)[0];
	assert(last, 'got a stream');
	assert.equal(last.status, 200);
	// Quay.io gives `Content-Type: binary/octet-stream` which has to
	// be a bug. AFAIK that isn't a real MIME type. Should be application/octet-stream
	assert.equal(last.headers.get('content-type'), 'binary/octet-stream');
	assert(
		last.headers.get('content-length') !== undefined,
		'got a "content-length" header',
	);

	const { hashHex, numBytes } = await hashAndCount(
		digest.split(':')[0],
		stream,
	);
	assert.equal(hashHex, digest.split(':')[1]);
	assert.equal(numBytes, Number(last.headers.get('content-length')));
});

it('v2 quay.io / createBlobReadStream (unknown digest)', async () => {
	const client = new RegistryClientV2({ repo });
	await assertThrowsHttp(async () => {
		await client.createBlobReadStream({ digest: 'cafebabe' });
	}, 405); // Not too sure why this is a 405 instead of a 404

	// Docker-Distribution-Api-Version header:
	// docker.io includes this header here, quay.io does not.
	// assert.equal(res.headers['docker-distribution-api-version'],
	//    'registry/2.0');
});
