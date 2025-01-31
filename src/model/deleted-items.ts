// Model for storing/tracking deleted items persistently.  See index.ts for how
// this fits in to the overall Tab Stash model (such as it is).

import {reactive} from 'vue';

import {nonReentrant} from '../util';
import {makeRandomString} from '../util/random';

import {KeyValueStore, Entry} from '../datastore/kvs';
import {friendlyFolderName} from './bookmarks';

// The key for a deleted record should be opaque but monotonically increasing as
// time passes, so items deleted more recently have greater keys.
export type Source = KeyValueStore<string, SourceValue>;
export type SourceValue = {
    deleted_at: string,
    deleted_from?: DeleteLocation,
    item: DeletedItem,
};

export type DeleteLocation = {
    // The folder containing the deleted item
    folder_id: string,
    title: string,
};


export type State = {
    fullyLoaded: boolean,
    entries: Deletion[], // entries are sorted newest first
    recentlyDeleted: Deletion[], // items deleted just a short time ago, oldest first
};

export type Deletion = {
    key: string,
    deleted_at: Date,
    deleted_from?: DeleteLocation,
    item: DeletedItem,
};

export type DeletedItem = DeletedBookmark | DeletedFolder;

export type DeletedBookmark = {
    title: string,
    url: string,
    favIconUrl?: string,
};

export type DeletedFolder = {
    title: string,
    children: DeletedItem[],
};

export function src2state(e: Entry<string, SourceValue>): Deletion {
    return reactive({
        key: e.key,
        deleted_at: new Date(e.value.deleted_at),
        deleted_from: e.value.deleted_from ? {...e.value.deleted_from} : undefined,
        item: 'children' in e.value.item
            ? {
                title: friendlyFolderName(e.value.item.title),
                children: e.value.item.children,
            }
            : e.value.item,
    });
}

const RECENT_DELETION_TIMEOUT = 8000; // ms



export class Model {
    // TODO make this transitively read-only (once I figure out the TypeScript
    // typing issues)
    readonly state: State = reactive({
        fullyLoaded: false,
        entries: [],
        recentlyDeleted: [],
    });

    private _kvs: KeyValueStore<string, SourceValue>;
    private _entry_cache = new Map<string, Deletion>();
    private _filter: undefined | ((item: DeletedItem) => boolean);

    private _clear_recently_deleted_timeout: undefined | ReturnType<typeof setTimeout>;

    constructor(kvs: KeyValueStore<string, SourceValue>) {
        this._kvs = kvs;

        // How to update the store on KVS changes.  These events are
        // reliable--we recieve them regardless of whether we are the one doing
        // the mutation on the KVS.
        kvs.onSet.addListener(records => this.onSet(records));
        kvs.onDelete.addListener(keys => this.onDelete(keys));
    }

    onSet(records: Entry<string, SourceValue>[]) {
        for (const r of records) {
            if (this._filter && ! this._filter(r.value.item)) continue;

            const {key, value} = r;
            const cached = this._entry_cache.get(key);
            if (cached) {
                cached.deleted_at = new Date(value.deleted_at);
                cached.item = value.item;
            } else {
                const r = src2state({key, value});
                this._entry_cache.set(key, r);
                if (r.deleted_at > this.state.entries[0]?.deleted_at) {
                    // This is the newest entry so it always goes first
                    this.state.entries.unshift(r);
                } else {
                    // TODO this is slow but hopefully very rare
                    this.state.entries.push(r);
                    this.state.entries.sort((a, b) =>
                        b.deleted_at.valueOf() - a.deleted_at.valueOf());
                }

                // Keep items we just deleted in a "recently deleted" list for a
                // short amount of time so the UI can show an "Undo"
                // notification.
                this.state.recentlyDeleted.push(r);
                if (this._clear_recently_deleted_timeout) {
                    clearTimeout(this._clear_recently_deleted_timeout);
                }
                this._clear_recently_deleted_timeout = setTimeout(() => {
                    this.state.recentlyDeleted = [];
                    this._clear_recently_deleted_timeout = undefined;
                }, RECENT_DELETION_TIMEOUT);
            }
        }
    }

    onDelete(keys: string[]) {
        for (const k of keys) this._entry_cache.delete(k);
        const kset = new Set(keys);
        const f = ({key}: {key: string}) => ! kset.has(key);

        this.state.entries = this.state.entries.filter(f);
        this.state.recentlyDeleted = this.state.recentlyDeleted.filter(f);
    }

    filter(predicate?: (item: DeletedItem) => boolean) {
        // This resets the model to the "empty" state.  On subsequent calls to
        // loadMore(), we will load only those records whose root DeletedItems
        // match the predicate (we do NOT search recursively; that's up to the
        // predicate if desired).
        //
        // We do top-level filtering in here for performance reasons--by lazily
        // loading/reloading filtered data, we can keep the number of elements
        // we report to the UI down, which keeps the UI responsive, because we
        // should rarely need potentially thousands of DOM nodes squeezed onto
        // the page.
        //
        // If the UI wants to filter *within* particular items, the UI needs to
        // do this by hand.  This strikes a balance between "heavy-lifting"
        // filtering which potentially ignores many, many items, and
        // fine-grained filtering in the UI (which can do nice things like
        // report the number of items filtered).
        this.state.fullyLoaded = false;
        this.state.entries = [];
        this._entry_cache = new Map();
        this._filter = predicate;
    }

    loadMore = nonReentrant(async() => {
        const starting_filter = this._filter;
        const starting_count = this.state.entries.length;
        let bound = this.state.entries.length > 0
            ? this.state.entries[this.state.entries.length - 1].key
            : undefined;

        // block.length might be > 0, and yet no entries will be loaded, if a
        // search is active.  In this case, we want to keep trying until we can
        // load at least one entry, or the infinite-loading component I'm using
        // in Vue will complain (and doing this is faster anyway).
        while (starting_count === this.state.entries.length) {
            // Check if we need to cancel the load because our filter has changed
            if (starting_filter !== this._filter) break;

            const block = await this._kvs.getEndingAt(bound, 10);
            this.onSet(block);

            if (block.length === 0) {
                this.state.fullyLoaded = true;
                break;
            }
            bound = block[block.length - 1].key;
        }
    });

    async add(
        item: DeletedItem,
        deleted_from?: DeleteLocation,
    ): Promise<Entry<string, SourceValue>> {
        // The ISO string has the advantage of being sortable...
        const deleted_at = new Date().toISOString();
        const key = `${deleted_at}-${makeRandomString(4)}`;
        const entry = {key, value: {
            deleted_at,
            deleted_from,
            // Get rid of reactivity (if any)
            item: JSON.parse(JSON.stringify(item))
        }};

        await this._kvs.set([entry]);
        // We will get an event that the entry has been added, which will insert
        // it in the model.

        return entry;
    }

    drop(key: string): Promise<void> {
        // We will get an event for the deletion later
        return this._kvs.delete([key]);
    }

    async dropChildItem(key: string, index: number): Promise<void> {
        const entry = this._entry_cache.get(key);
        // istanbul ignore next
        if (! entry) throw new Error(`${key}: Record not loaded or doesn't exist`);
        // istanbul ignore next
        if (! ('children' in entry.item)) throw new Error(`${key}: Not a folder`);

        // Must do a full JSON parse/stringify here to get rid of reactivity
        const children = JSON.parse(JSON.stringify(entry.item.children));
        children.splice(index, 1);
        await this._kvs.set([{
            key,
            value: {
                deleted_at: entry.deleted_at.toISOString(),
                item: {title: entry.item.title, children},
            },
        }]);
    }

    // Cleanup deleted items which are older than the specified date.
    //
    // We go directly to the KVS regardless of what's loaded into the model
    // because that way we are guaranteed to see everything, and we don't want
    // to pollute the model with stuff we're about to delete.
    async dropOlderThan(timestamp: number): Promise<void> {
        while (true) {
            const to_delete = [];
            for (const rec of await this._kvs.getStartingFrom(undefined, 50)) {
                if (Date.parse(rec.value.deleted_at) < timestamp) {
                    to_delete.push(rec.key);
                }
            }

            if (to_delete.length > 0) await this._kvs.delete(to_delete);
            else break;
        }
    }

    async makeFakeData_testonly(count: number) {
        let ts = Date.now();
        const icons = [
            'back.svg', 'cancel.svg', 'collapse-closed.svg', 'delete.svg',
            'logo.svg', 'mainmenu.svg', 'new-empty-group.svg',
            'restore-del.svg', 'stash-one.svg', 'stash.svg',
        ];
        const words = [
            'deleted', 'internal', 'cat', 'nonsense', 'wakka', 'yakko', 'dot',
            'gazebo', 'meow', 'mew', 'bark', 'widget', 'boat', 'car', 'rental',
            'code', 'monad', 'block', 'function', 'trivia', 'noise', 'signal',
        ];
        const choose = (a: any[]) => a[Math.floor(Math.random() * a.length)];
        const genTitle = () => `${choose(words)} ${choose(words)} ${choose(words)}`;
        const genUrl = () => `https://${choose(words)}.internet/${choose(words)}/${choose(words)}/${choose(words)}.html`;
        const genIcon = () => `icons/light/${choose(icons)}`;

        for (let i = 0; i < count; ++i) {
            const deleted_at = new Date(ts).toISOString();
            const key = `${deleted_at}-${makeRandomString(4)}`;
            ts -= Math.floor(Math.random() * 6*60*60*1000);
            if (Math.random() < 0.5) {
                await this._kvs.set([{
                    key,
                    value: {
                        deleted_at,
                        item: {
                            title: genTitle(),
                            children: (() => {
                                const res = [];
                                for (let i = 0; i < Math.random()*10+1; ++i) {
                                    res.push({
                                        title: genTitle(),
                                        url: genUrl(),
                                        favIconUrl: genIcon(),
                                    });
                                }
                                return res;
                            })(),
                        },
                    },
                }]);
            } else {
                await this._kvs.set([{
                    key,
                    value: {
                        deleted_at,
                        deleted_from: {
                            folder_id: choose(words),
                            title: genTitle(),
                        },
                        item: {
                            title: genTitle(),
                            url: genUrl(),
                            favIconUrl: genIcon()
                        },
                    },
                }]);
            }
        }
    }
};
