const binance = require('node-binance-api')
const express = require('express')
const path = require('path')
var _ = require('lodash')
var moment = require('moment')
var numeral = require('numeral')
var readline = require('readline')
var fs = require('fs')
const play = require('audio-play')
const load = require('audio-loader')
const nodemailer = require('nodemailer')

//////////////////////////////////////////////////////////////////////////////////

// https://www.binance.com/restapipub.html
const APIKEY = 'xxx'
const APISECRET = 'xxx'

const tracked_max = 1000
const depth_limit = 10
const wait_time = 1000 			// ms

let pairs = []

let depth_bids = {}
let depth_asks = {}

let vol = []

let minute_prices = {}
let avgBuyVol = []
let avgBuyVol2 = []

let isTrading = []
let metFirstTarget = []
let buyingPrice = []
let tradingTime = []

let totalProfit = 0

//////////////////////////////////////////////////////////////////////////////////
// that's where you define your buying conditions:
//////////////////////////////////////////////////////////////////////////////////

bump_detect = (pair, tick) => {
	let { t:time, o:open, h:high, l:low, c:close, v:volume, n:trades, i:interval, x:isFinal, q:quoteVolume, V:buyVolume, Q:quoteBuyVolume } = tick
	let buyPercentVol = quoteBuyVolume / quoteVolume 
	let averageBuyVol = (quoteBuyVolume - avgBuyVol[pair])/avgBuyVol[pair]
	let averageBuyVol2 = (quoteBuyVolume - avgBuyVol2[pair])/avgBuyVol2[pair]
	let priceDiff = (close - minute_prices[pair][0][4])/minute_prices[pair][0][4]
	//console.log(buyPercentVol + "," + averageBuyVol + "," + priceDiff)
	if (!isTrading[pair]) {
		if (!metFirstTarget[pair]) {
			if (isFinal && buyPercentVol > 0.7 && averageBuyVol > 1 && averageBuyVol2 > 1 && priceDiff >= 0.002 && quoteBuyVolume >= vol[pair]/200) {
				console.log(pair + " 1 > " + buyPercentVol + "," + averageBuyVol + "," + averageBuyVol2 + "," + priceDiff + "," + quoteBuyVolume)
				metFirstTarget[pair] = true
			}
		} else {
			if (quoteBuyVolume >= minute_prices[pair][0][10]*0.7 && averageBuyVol > 1 && averageBuyVol2 > 1 && priceDiff >= 0) {
				console.log(pair + " 2 > " + buyPercentVol + "," + averageBuyVol + "," + averageBuyVol2 + "," + priceDiff + "," + quoteBuyVolume)
				metFirstTarget[pair] = false
				tradingTime[pair] = time
				return "BUY"
			} else if (isFinal) {
				console.log(pair + " 2 > reset")
				metFirstTarget[pair] = false
			}
		}
		return "HOLD"
	} else if (tradingTime[pair] != time) {
		if (isFinal && quoteBuyVolume >= minute_prices[pair][0][10]*0.8  && priceDiff >= -0.004) {
			console.log(pair + " 3 > " + buyPercentVol + "," + averageBuyVol + "," + averageBuyVol2 + "," + priceDiff + "," + quoteBuyVolume)
			return "HOLD"
		} 
		if (isFinal) {
			console.log(pair + " 4 > " + buyPercentVol + "," + averageBuyVol + "," + averageBuyVol2 + "," + priceDiff + "," + quoteBuyVolume)
			return "SELL"
		}
	}
}

let strategies = [ 
	{ name: "BUMP", condition: bump_detect }, 
]

//////////////////////////////////////////////////////////////////////////////////

// API initialization //
binance.options({ 'APIKEY': APIKEY, 'APISECRET': APISECRET, 'reconnect': true });

console.log('------------ NBT starting -------------')

async function run() {

	await sleep(2)

	console.log('------------------------------')
	console.log(' get_BTC_pairs start')
	console.log('------------------------------')
	pairs = await get_BTC_pairs()
	console.log('------------------------------')
	pairs = pairs.slice(0, tracked_max) //for debugging purpose
	console.log("Total BTC pairs: " + pairs.length)
	console.log('------------------------------')
	
	await sleep(2)

	console.log('------------------------------')
	console.log(' trackMinutePrices start')
	console.log('------------------------------')
	await trackMinutePrices()
	console.log('------------------------------')

	console.log('------------ we are ready to track all strategies -------------')
}

sleep = (x) => {
	return new Promise(resolve => {
		setTimeout(() => { resolve(true) }, x )
	});
}

function filterPairs(pair) {
	vol[pair.symbol] = pair.quoteVolume 
	if (pair.symbol.endsWith('BTC') && pair.quoteVolume >= 400 && pair.quoteVolume <= 99999) {
    		return true;
	} 
	return false; 
}

get_BTC_pairs = () => {
	return new Promise(resolve => {
		binance.prevDay(false, (error, data) => {
			if (error) {
				console.log( error )
				resolve([])
			}
			if (data) {
				resolve( data.filter(filterPairs).map(pair=>pair.symbol) )
			}
		})
	})
}

trackDepthPair = (pair) => {
	return new Promise(resolve => {
		console.log( "> starting tracking depth data for " + pair )
		binance.websockets.depthCache([pair], (symbol, depth) => {
			var bids = binance.sortBids(depth.bids, depth_limit)
			var asks = binance.sortAsks(depth.asks, depth_limit)
			depth_asks[pair] = _.sum(_.values(asks).slice(0,depth_limit))*binance.first(asks)
			depth_bids[pair] = _.sum(_.values(bids).slice(0,depth_limit))*binance.first(bids)
			depth_diff[pair] = 100 * (binance.first(asks) - binance.first(bids)) / (binance.first(bids))
		}, depth_limit);
		resolve(true)
	}, depth_limit)
}

async function trackDepthData() {
	for (var i = 0, len = pairs.length; i < len; i++) {
		var pair = pairs[i]
		await trackDepthPair(pair)
		await sleep(wait_time)
		console.log( (i+1) + " > " + pair + " depth tracked a:" + numeral(depth_asks[pair]).format("0.00") + " / b:" + numeral(depth_bids[pair]).format("0.00") )
	}
}

getPrevMinutePrices = (pair) => {
	return new Promise(resolve => {
		binance.candlesticks(pair, "5m", (error, ticks, symbol) => {
			if (error) {
				console.log( pair + " getPrevMinutePrices ERROR " + error )
				resolve(true)
			}
			if (ticks) {
				minute_prices[symbol] = _.drop(_.reverse( ticks )) 
				avgBuyVol[symbol] = minute_prices[symbol].map(tick => tick[10]).reduce((sum, price) => (sum + parseFloat(price)), 0) / minute_prices[symbol].length
				avgBuyVol2[symbol] = minute_prices[symbol].slice(0,6).map(tick => tick[10]).reduce((sum, price) => (sum + parseFloat(price)), 0) / minute_prices[symbol].length
				//console.log(avgBuyVol[symbol])
				resolve(true)
			}
		}, {limit:13})
	})
}

async function trackMinutePrices() {
	for (var i = 0, len = pairs.length; i < len; i++) {
		isTrading[pairs[i]] = false
		metFirstTarget[pairs[i]] = false
		//warmup
		await getPrevMinutePrices(pairs[i])
		//await sleep(wait_time)
		console.log( (i+1) + " > " + pairs[i] + " " + minute_prices[pairs[i]].length + " unit prices retrieved")
		await trackFutureMinutePrices(pairs[i])
		//await sleep(wait_time)
		console.log( (i+1) + " > " + pairs[i] + " future prices tracked.")
	}
}

trackFutureMinutePrices = (pair) => {
	return new Promise(resolve => {
		binance.websockets.candlesticks([pair], "5m", (candlesticks) => {
			let { e:eventType, E:eventTime, s:symbol, k:ticks } = candlesticks
			let { t:time, o:open, h:high, l:low, c:close, v:volume, n:trades, i:interval, x:isFinal, q:quoteVolume, V:buyVolume, Q:quoteBuyVolume } = ticks
			//console.log("> new tick for pair: " + pair)
			//console.log(ticks)
			strategies.map( strat => {
				if (!isTrading[pair]) {
					if (strat.condition(symbol, ticks) === "BUY") {
						isTrading[pair]=true
						buyingPrice[pair] = close
						console.log("BUY " + symbol + " - " + close + " = " + vol[symbol])
					}	
				} else {
					if (strat.condition(symbol, ticks) === "SELL") {
						isTrading[pair]=false
						console.log("SELL " + symbol + " - " + close + " - " + vol[symbol])
						let profit = ((close - buyingPrice[pair]) / buyingPrice[pair]) - 0.001
						totalProfit += profit
						console.log(symbol + " > Profit: " + profit + " / Net: " + totalProfit)
					} 
				}
			})
			if (isFinal) {
				//console.log("update 5m")
				let tick = minute_prices[symbol].pop()
				tick[0] = time
				tick[1] = open
				tick[2] = high
				tick[3] = low
				tick[4] = close
				tick[5] = volume
				tick[6] = 0
				tick[7] = quoteVolume
				tick[8] = trades
				tick[9] = buyVolume
				tick[10] = quoteBuyVolume 
				minute_prices[symbol].unshift(tick)
				//console.log(minute_prices[symbol])
				avgBuyVol[symbol] = minute_prices[symbol].map(tick => tick[10]).reduce((sum, price) => (sum + parseFloat(price)), 0) / minute_prices[symbol].length
				avgBuyVol2[symbol] = minute_prices[symbol].slice(0,6).map(tick => tick[10]).reduce((sum, price) => (sum + parseFloat(price)), 0) / minute_prices[symbol].length
				//console.log(avgBuyVol[symbol])
			}
		});
		resolve(true)
	})
}

console.log = (function() {
  var console_log = console.log;
  
  return function() {
    var args = [];
    args.push(new Date().toISOString() + ' : ');
    for(var i = 0; i < arguments.length; i++) {
      args.push(arguments[i]);
    }
    console_log.apply(console, args);
  };
})();

run()

console.log("----------------------")

const app = express()
app.get('/', (req, res) => res.send(pairs))
app.listen(8080, () => console.log('NBT api accessable on port 8080'))
