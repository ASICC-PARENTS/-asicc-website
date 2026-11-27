import test from 'node:test';
import assert from 'node:assert/strict';
import {matchesMailAudience} from '../src/lib/bazaar/admin/mail-audience.mjs';
const order=(status,extra={})=>({email:'fixture@example.test',status,...extra});
const rows=[
 order('unpaid'),order('reported',{reportedAt:'2026-11-27'}),order('confirmed',{bankConfirmedAt:'2026-11-27',payment:{settled:true}}),
 order('partial',{bankConfirmedAt:'2026-11-27',payment:{settled:false}}),order('canceled',{mailCancelReason:'buyer'}),
 order('canceled',{mailCancelReason:'admin'}),order('canceled',{mailCancelReason:'unpaidFinalization'}),order('unpaid',{email:''})
];
const ids=(type,audience,exclude=true)=>rows.map((row,index)=>matchesMailAudience(row,type,audience,exclude)?index:-1).filter(i=>i!==-1);
test('unpaid excludes confirmed, partial, canceled and missing-email rows',()=>{
 assert.deepEqual(ids('reminderFinal','unpaid'),[0]);
 assert.deepEqual(ids('reminderFinal','unpaid',false),[0,1]);
});
test('audience and message type are intersected, never broadened',()=>{
 assert.deepEqual(ids('other','valid'),[0,1,2,3]);
 assert.deepEqual(ids('pickup','confirmed'),[2]);
 assert.deepEqual(ids('receipt','unpaid',false),[0,1]);
 assert.deepEqual(ids('confirmed','unpaid'),[]);
 assert.deepEqual(ids('reminderFinal','confirmed'),[]);
});
test('cancel notices only include the corresponding cancellation reason',()=>{
 assert.deepEqual(ids('other','canceled'),[4,5,6]);
 assert.deepEqual(ids('buyerCancel','canceled'),[4]);
 assert.deepEqual(ids('adminCancel','canceled'),[5]);
 assert.deepEqual(ids('bulkCancel','canceled'),[6]);
 assert.deepEqual(ids('bulkCancel','valid'),[]);
});
