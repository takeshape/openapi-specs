import {load} from 'cheerio';
import got from 'got';
import pMap from 'p-map';
import {writeFileSync} from 'fs';
import {URL} from 'url';
import merge from 'lodash/merge.js';
import {delay} from "@takeshape/util";

const args = process.argv.slice(2);
const rootUrl = args[0];
const {hostname, protocol} = new URL(rootUrl);
const baseUrl = `${protocol}//${hostname}`;

async function main() {
    const html = await got.get(rootUrl).text();
    const $ = load(html);

    const urls = new Set();
    $('.rm-Sidebar-link').each((i, el) => {
        const href = $(el).attr('href');
        if (href.includes('/reference/')) {
            urls.add(`${baseUrl}${href}`);
        }
    });



    let spec = {};

    await pMap([...urls], async url => {
        try {
            await delay(1000);
            const data = await got({
                method: 'GET',
                headers: {
                    referer: url,
                    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36',
                    'x-requested-with': 'XMLHttpRequest'
                },
                url: `${url}?json=on`
            }).json();
            if (data.oasDefinition) {
                spec = merge(spec, data.oasDefinition);
            }

            console.log('Success', url);
        } catch (e) {
            console.log(`Failed to get OAS spec for ${url}`,);
        }
    }, {concurrency: 1});

    writeFileSync(`${hostname}.spec.json`, JSON.stringify(spec, null, 2), {encoding: 'utf-8'});
}

main();