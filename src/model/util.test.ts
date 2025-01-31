// This is mostly "gap" test coverage since we get plenty of incidental coverage
// from testing the actual models.  You should look at those for real-world
// examples.

import {expect} from 'chai';
import {reactive, nextTick} from 'vue';

import * as M from './util';

type T = {k: string, v: string, i: number};

describe('model/util', () => {
    let map: M.EventfulMap<string, T>;
    let index: M.Index<string, string, T>;

    beforeEach(() => {
        map = new M.EventfulMap();
        index = new M.Index(map, {
            keyFor(v) { return v.k; },
            positionOf(v) { return v.i; },
            whenPositionChanged(v, i) { v.i = i; },
        });
    });

    describe('EventfulMap', () => {
        it('inserts objects and fires onInsert events', () => {
            let fired = false;
            map.onInsert.addListener((k, v) => {
                fired = true;
                expect(k).to.equal('asdf');
                expect(v).to.deep.equal({k: 'asdf', v: 'qwer', i: 0});
            });

            map.insert('asdf', reactive({k: 'asdf', v: 'qwer', i: 0}));
            expect(map.get('asdf')).to.deep.equal({k: 'asdf', v: 'qwer', i: 0});
            expect(fired).to.be.true;
        });

        it('updates objects and fires onUpdate events', async () => {
            const obj = reactive({k: 'asdf', v: 'qwer', i: 0});
            map.insert('asdf', obj);

            obj.v = 'hello';

            let fired = false;
            map.onUpdate.addListener((k, v) => {
                fired = true;
                expect(k).to.equal('asdf');
                expect(v.v).to.equal('hello');
                expect(v).to.equal(obj);
            });

            await nextTick();
            expect(fired).to.be.true;
        });

        it('gracefully ignores move()s for invalid keys', () => {
            expect(map.move('nowhere', 'nowhere else')).to.be.undefined;
        });
    });

    describe('Index', () => {
        it('detects updates when connected to an existing map', async () => {
            const o = reactive({k: 'f', v: 'v', i: 0});
            map.insert('f', o);

            const idx = new M.Index(map, {
                keyFor(v) { return v.k; }
            });

            expect(idx.get('f')).to.deep.equal([o]);

            o.k = 'g';
            await nextTick();
            expect(idx.get('g')).to.deep.equal([o]);
            expect(idx.get('f')).to.deep.equal([]);
        });

        it('throws if something non-reactive is inserted', () => {
            expect(() => map.insert('a', {k: 'a', v: 'b', i: 0})).to.throw(Error);
        });

        it('throws on duplicate key insertions', () => {
            const v = reactive({k: 'a', v: 'b', i: 0});
            map.insert('a', v);
            expect(() => map.insert('a', v)).to.throw(Error);
            expect(index.get('a')).to.deep.equal([v]);
        });

        it('throws on duplicate value insertions', () => {
            const v = reactive({k: 'a', v: 'b', i: 0});
            map.insert('a', v);
            expect(() => map.insert('b', v)).to.throw(Error);
            expect(index.get('a')).to.deep.equal([v]);
        });

        it('gracefully handles duplicate deletes', () => {
            const v = reactive({k: 'a', v: 'b', i: 0});
            map.insert('a', v);
            map.delete('a');
            map.delete('a');
            expect(index.get('a')).to.deep.equal([]);
        });
    });
});
