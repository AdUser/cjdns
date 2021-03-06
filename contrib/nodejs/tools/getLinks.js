#!/usr/bin/env node
/* vim: set expandtab ts=4 sw=4: */
/*
 * You may redistribute this program and/or modify it under the terms of
 * the GNU General Public License as published by the Free Software Foundation,
 * either version 3 of the License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
var Cjdns = require('../cjdnsadmin/cjdnsadmin');
var nThen = require('../cjdnsadmin/nthen');
var PublicToIp6 = require('./lib/publicToIp6');

var NodeStore_getNode = function(cjdns, state, addr, callback) {
    if (typeof(state['NodeStore_getNode' + addr]) !== 'undefined') {
        callback(state['NodeStore_getNode' + addr]);
    } else {
        //console.log('NodeStore_getNode(' + addr + ');');
        cjdns.NodeStore_getNode(addr, function (err, ret) {
            if (err) { throw err; }
            state['NodeStore_getNode' + addr] = ret;
            callback(ret);
        });
    }
};

var NodeStore_getRouteLabel = function(cjdns, state, parentPath, childAddr, callback) {
    var key = 'NodeStore_getRouteLabel' + parentPath + ', ' + childAddr;
    if (typeof(state[key]) !== 'undefined') {
        callback(state[key]);
    } else {
        //console.log('NodeStore_getRouteLabel(' + parentPath + ', ' + childAddr + ');');
        cjdns.NodeStore_getRouteLabel(parentPath, childAddr, function (err, ret) {
            if (err) { throw err; }
            state[key] = ret;
            callback(ret);
        });
    }
};

var NodeStore_getLink = function (cjdns, state, addr, num, callback) {
    var key = 'NodeStore_getLink' + addr + ', ' + num;
    if (typeof(state[key]) !== 'undefined') {
        callback(state[key]);
    } else {
        //console.log('NodeStore_getLink(' + addr + ', ' + num + ');');
        cjdns.NodeStore_getLink(addr, num, function (err, ret) {
            if (err) { throw err; }
            state[key] = ret;
            callback(ret);
        });
    }
};

var getNode = function (cjdns, next, output, state, parentPath, ipsByReach, nodes, callback) {

    if (next.parent === next.child || nodes.indexOf(next.child) > -1) { process.nextTick(callback); return; }
    nodes.push(next.child);

    var getNodeRet;
    var path = undefined;
    nThen(function (waitFor) {

        NodeStore_getNode(cjdns, state, next.child, waitFor(function (ret) {
            //console.log('cjdns.NodeStore_getNode(' + next.child + '); --> ' + JSON.stringify(ret, null, '  '));
            getNodeRet = ret;
        }));

    }).nThen(function (waitFor) {

        if (!parentPath) {
            return;
        }

        NodeStore_getRouteLabel(cjdns, state, parentPath, next.child, waitFor(function (ret) {
            if (ret.error !== 'none') {
                throw new Error('cjdns.NodeStore_getRouteLabel(' + parentPath + ', ' + next.child +
                    '); --> ' + JSON.stringify([ret, parents], null, '  '));
            }
            if (ret.result !== 'ffff.ffff.ffff.ffff') {
                path = ret.result;
            }
        }));

    }).nThen(function (waitFor) {

        //console.log(spaces + next.child + '  ' + next.cannonicalLabel + " -> " + path);
        // if next.parent skips the bootstrap route
        if (next.parent) {
            var out = {};
            output.push(out);
            output = out;
        }
        if (output.peers) { /* sanity check */ throw new Error(); }
        output.addr = next.child;
        output.cannonicalLabel = next.cannonicalLabel;
        output.fullPath = path;
        output.peers = [];

        if (!path) { return; }

        var links = [];
        nThen(function (waitFor) {

            for (var i = 0; i < getNodeRet.result.linkCount; i++) {
                NodeStore_getLink(cjdns, state, next.child, i, waitFor(function (ret) {
                    links.push(ret);
                }));
            }

        }).nThen(function (waitFor) {

            //console.log(JSON.stringify(links, null, '  '));
            links.sort(function (a,b) {
                return (ipsByReach.indexOf(a.result.child) < ipsByReach.indexOf(b.result.child)) ?
                    -1 : 1;
            });
            //console.log(JSON.stringify(links, null, '  '));
            //console.log(JSON.stringify(ipsByReach, null, '  '));
            for (var i = 0; i < links.length; i++) {
                getNode(cjdns, links[i].result, output.peers, state, path, ipsByReach, nodes, waitFor());
            }

        }).nThen(waitFor());

    }).nThen(function (waitFor) {

        callback();

    });
};

var dumpOldTable = function (cjdns, callback) {
    var output = [];
    var again = function (i) {
        cjdns.NodeStore_dumpTable(i, function (err, table) {
            if (err) { throw err; }
            var j;
            for (j = 0; j < table.routingTable.length; j++) {
                var r = table.routingTable[j];
                output.push(r);
            }
            if (j) {
                again(i+1);
            } else {
                callback(output);
            }
        });
    };
    again(0);
};

var ipsByReachDesc = function (cjdns, callback) {
    dumpOldTable(cjdns, function (oldTable) {

        oldTable.sort(function (a, b) {
            if (a.ip !== b.ip) { return (a.ip > b.ip) ? 1 : -1; }
            if (a.link !== b.link) { return (Number(a.link) < Number(b.link)) ? 1 : -1; }
            if (a.path !== b.path) { return (a.path > b.path) ? 1 : -1; }
            throw new Error("dupe entry");
        });
        var bestReaches = [];
        var last;
        for (var i = 0; i < oldTable.length; i++) {
            var r = oldTable[i];
            if (last !== r.ip) {
                bestReaches.push({ip:r.ip, link:r.link});
                last = r.ip;
            }
        }
        bestReaches.sort(function (a, b) { return (a.link > b.link) ? 1 : -1; });
        var out = [];
        for (var i = 0; i < bestReaches.length; i++) {
            out.push(bestReaches[i].ip);
        }
        callback(out);
        //bestReaches.forEach(function (node) { console.log(node.ip + '  ' + node.link); });
    });
};

var getTree = function (cjdns, callback) {
    ipsByReachDesc(cjdns, function (ipsByReach) {

        cjdns.NodeStore_getNode(undefined, function (err, ret) {
            if (err) { throw err; }
            var myIp6 = PublicToIp6.convert(ret['result']['key']);
            var output = {};
            var selfRoute = '0000.0000.0000.0001';
            var initialNode = { child: myIp6, cannonicalLabel: selfRoute };
            getNode(cjdns, initialNode, output, {}, selfRoute, ipsByReach, [], function () {
                callback(output);
            });
        });
    });
};

var printTree = function (cjdns, tree, callback) {
    var pt = function (tree, spaces, callback) {
        var nt = nThen(function (waitFor) {
            process.stdout.write(spaces + tree.addr + '  ' + tree.cannonicalLabel + ' --> ' + tree.fullPath);
            if (tree.fullPath === '0000.0000.0000.0001') { return; }
            cjdns.RouterModule_pingNode(tree.fullPath, waitFor(function (err, ret) {
                if (err) { throw err; }
                var resp = (ret.result !== 'pong') ? "[" + ret.error + "]" : (ret.ms + 'ms.');
                process.stdout.write('  rp:' + resp);
            }));
        }).nThen(function (waitFor) {
            cjdns.SwitchPinger_ping(tree.fullPath, waitFor(function (err, ret) {
                if (err) { throw err; }
                var resp = (ret.result !== 'pong') ? ret.error : (ret.ms + 'ms.');
                process.stdout.write('  sp:' + resp + '\n');
            }));
        }).nThen;

        tree.peers.forEach(function (peer) {
            nt = nt(function (waitFor) {
                pt(peer, '  ' + spaces, waitFor());
            }).nThen;
        });

        nt(callback);
    };
    pt(tree, '', callback);
};

Cjdns.connectWithAdminInfo(function (cjdns) {

    getTree(cjdns, function (output) {
        //console.log(JSON.stringify(output, null, '  '));
        printTree(cjdns, output, function() {
            cjdns.disconnect();
        });
    });

});
