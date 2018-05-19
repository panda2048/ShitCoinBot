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

const tracked_max = 200
const wait_time = 150 			// ms

const depth_limit = 10

const M = 100000000

let isReady = false

let pairs = []
let ticksize = []

let vol = []

let bidask = []

let minute_prices = {}
let ema = []
let stoch_k = []
let stoch_kx = []
let stoch_d = []
let fisher_n = []
let fisher = []

const ema_period = 200
const k = 14
const kx = 3
const d = 3
const fisher_period = 10

let isTrading = []
let buyingPrice = []
let buyingTime = []
let stopgain = []
let stoploss = []

let signal1 = []

let totalProfit = 0

let numBuy = 0
let maxBuy = 0

//////////////////////////////////////////////////////////////////////////////////
// that's where you define your buying conditions:
//////////////////////////////////////////////////////////////////////////////////

function buying(pair, candlesticks) {
	if (!isReady) return

	let { e:eventType, E:eventTime, s:symbol, k:ticks } = candlesticks
	let { t:time, o:_open, h:_high, l:_low, c:_close, v:volume, n:trades, i:interval, x:isFinal, q:quoteVolume, V:buyVolume, Q:quoteBuyVolume } = ticks

	let open = (_open*M).toFixed(0)
	let high = (_high*M).toFixed(0)
	let low = (_low*M).toFixed(0)
	let close = (_close*M).toFixed(0)

	let _ema = (_close - ema[symbol])*(2/(ema_period+1))+ema[symbol]
	let max_high = Math.max(_high, Math.max.apply(null, minute_prices[symbol].slice(0,k-1).map(tick => tick[2])))
	let min_low = Math.min(_low, Math.min.apply(null, minute_prices[symbol].slice(0,k-1).map(tick => tick[3])))
	let _k = ((_close - min_low)/(max_high - min_low))*100
	let _kx = (_k + stoch_k[symbol].slice(0,kx-1).reduce((sum, price) => (sum + parseFloat(price)), 0)) / kx
	let _d = (_kx + stoch_kx[symbol].slice(0,d-1).reduce((sum, price) => (sum + parseFloat(price)), 0)) / d

	let hl2 = (parseFloat(_high)+parseFloat(_low))/2
	let max_hl2 = Math.max(hl2, Math.max.apply(null, minute_prices[symbol].slice(0,fisher_period-1).map(tick => (parseFloat(tick[2])+parseFloat(tick[3]))/2)))
	let min_hl2 = Math.min(hl2, Math.min.apply(null, minute_prices[symbol].slice(0,fisher_period-1).map(tick => (parseFloat(tick[2])+parseFloat(tick[3]))/2)))
	
	let _fisher_n = 0.33*2*((hl2-min_hl2)/(max_hl2-min_hl2)-0.5)+0.67*fisher_n[symbol]
	let x = _fisher_n>0.99?0.99999999:_fisher_n<-0.99?-0.99999999:_fisher_n
	let _fisher = 0.5*Math.log((1+x)/(1-x))+0.5*fisher[symbol]
	
	if (!isTrading[pair] && isFinal) {
		if (_fisher <= fisher[symbol]) { 
			signal1[symbol] = true
		}
		if (signal1[symbol] && _close >= _ema) {
			if (fisher[symbol] < -2) console.log(pair + " > 1.0 > " + _fisher + "," + fisher[symbol])
			if (fisher[symbol] < -2 && _fisher < -2 && _fisher > fisher[symbol] && _kx >= 20 && _kx <= 70 && quoteVolume/vol[symbol] >= 0.005) {
				console.log(pair + " > 1.1 > " + _fisher + "," + fisher[symbol])
				console.log(pair + " > 1.2 > " + quoteBuyVolume/quoteVolume + "," + quoteBuyVolume/vol[symbol] + "," + quoteVolume/vol[symbol])

				return "BUY"
			}
		}
		if (_fisher > fisher[symbol]) { 
			signal1[symbol] = false
		}
	}
}

function selling(pair, ts) {
	if (!isReady) return
	
	if (isTrading[pair]) {
		let _stopgain = buyingPrice[pair] + Math.round(buyingPrice[pair]*0.005)
		let _stoploss = buyingPrice[pair] - Math.round(buyingPrice[pair]*0.0025)
		if (bidask[pair][0][0][0] >= _stopgain) {
			console.log(pair + " > 2.1 > " + _stopgain)
			signal1[pair]=false
			return "SELL"
		} else if (bidask[pair][0][0][0] <= _stoploss) {
			console.log(pair + " > 2.2 > " + _stoploss)
			signal1[pair]=false
			return "SELL"
		}
	}
}

//////////////////////////////////////////////////////////////////////////////////

// API initialization //
binance.options({ 'APIKEY': APIKEY, 'APISECRET': APISECRET, 'reconnect': true });

console.log('------------ NBT starting -------------')

async function run() {

	console.log('------------------------------')
	console.log(' get_BTC_pairs start')
	console.log('------------------------------')
	pairs = await get_BTC_pairs()
	console.log('------------------------------')
	pairs = pairs.slice(0, tracked_max) //for debugging purpose
	console.log("Total BTC pairs: " + pairs.length)
	console.log('------------------------------')
/*
  //await get_ticksize()
	await sleep(10000)

	console.log('------------------------------')
	console.log(' trackVolumeData start')
	console.log('------------------------------')
	await trackVolumeData()
	console.log('------------------------------')
	
	await sleep(10000)

	console.log('------------------------------')
	console.log(' trackMinutePrices start')
	console.log('------------------------------')
	await trackMinutePrices()
	console.log('------------------------------')

	await sleep(10000)
*/
	console.log('------------------------------')
	console.log(' trackDepthData start')
	console.log('------------------------------')
	await trackDepthData()
	console.log('------------------------------')

  //isReady = true
	console.log('------------ we are ready to track all strategies -------------')
}

sleep = (x) => {
	return new Promise(resolve => {
		setTimeout(() => { resolve(true) }, x )
	});
}

function filterPairs(pair) {
	if (pair.symbol.endsWith('BTC') && pair.prevClosePrice > 0) {
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

get_ticksize = () => {
	return new Promise(resolve => {
		binance.exchangeInfo((error, data) => {
			for ( let obj of data.symbols ) {
				for ( let filter of obj.filters ) {
					if ( filter.filterType == "PRICE_FILTER" ) {
						ticksize[obj.symbol] = filter.tickSize*M;
					}
				}
			}
			resolve(true)
		})
	})
}

trackVolumePair = (pair) => {
	return new Promise(resolve => {
		binance.websockets.prevDay([pair], (error, data) => {
			if (error) {
				console.log( error )
				resolve([])
			}
			vol[pair] = data.quoteVolume 
			//console.log(pair + "=" + data.quoteVolume)
			resolve(true)
		})
	})
}

async function trackVolumeData() {
	for (var i = 0, len = pairs.length; i < len; i++) {
		var pair = pairs[i]
		trackVolumePair(pair)
		await sleep(wait_time)
	}
}

async function trackDepthData() {
	for (var i = 0, len = pairs.length; i < len; i++) {
		await trackDepthPair(pairs[i])
		await sleep(wait_time)
	}
}

trackDepthPair = (pair) => {
	return new Promise(resolve => {
		let symbol = pair
		binance.websockets.depth([pair], (depth) => {
/*			let _b = [] 
			let _a = []
			let bids = binance.sortBids(depth.bids, depth_limit)
			let asks = binance.sortAsks(depth.asks, depth_limit)
		
			for (let o = 0; o < depth_limit; o++) {
				_b[o] = []
				_b[o][0] = parseFloat(_.keys(bids)[o])*M
				_b[o][1] = parseFloat(_.values(bids)[o])
				_a[o] = []
				_a[o][0] = parseFloat(_.keys(asks)[o])*M
				_a[o][1] = parseFloat(_.values(asks)[o])
			}
			bidask[symbol] = []
			bidask[symbol][0] = _b
			bidask[symbol][1] = _a

			if (isTrading[pair]) {
				var ts = (new Date()).getTime()
				let cond = selling(symbol, ts)
					if (cond === "SELL") {
					isTrading[pair] = false
					numBuy--
					console.log(symbol + " SELL - " + bidask[symbol][0][0][0] + " - " + numBuy + "," + maxBuy)
					let profit = ((bidask[symbol][0][0][0] - buyingPrice[pair]) / buyingPrice[pair]) - 0.001
					totalProfit += profit
					console.log(symbol + " > Profit: " + profit + " / Net: " + totalProfit)
				}
			}
*/	  
			resolve(true)
		})
		resolve(true)
	})
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
				// EMA
				ema[symbol] = minute_prices[symbol].slice(ema_period).map(tick => tick[4]).reduce((sum, price) => (sum + parseFloat(price)), 0) / ema_period

				for (let i=ema_period-1; i >= 0; i--) {
					ema[symbol] = (minute_prices[symbol][i][4] - ema[symbol])*(2/(ema_period+1))+ema[symbol]
				}
			
				//Stochastic
				stoch_k[symbol] = []
				stoch_kx[symbol] = []
				stoch_d[symbol] = []
				for (let j=ema_period-k; j>=0; j--) {
					//console.log(minute_prices[symbol].slice(j,j+k))
					let max_high = Math.max.apply(null, minute_prices[symbol].slice(j,j+k).map(tick => tick[2]))
					let min_low = Math.min.apply(null, minute_prices[symbol].slice(j,j+k).map(tick => tick[3]))
					//console.log(max_high, min_low)
					stoch_k[symbol].unshift(((minute_prices[symbol][j][4] - min_low)/(max_high - min_low))*100)
					if (stoch_k[symbol].length >= kx) {
						if (stoch_k[symbol].length > kx) stoch_k[symbol].pop()
						//console.log("k " + stoch_k[symbol])
						stoch_kx[symbol].unshift(stoch_k[symbol].reduce((sum, price) => (sum + parseFloat(price)), 0) / kx)
						if (stoch_kx[symbol].length >= d) {
							if (stoch_kx[symbol].length > d) stoch_kx[symbol].pop()
							stoch_d[symbol].pop()
							//console.log("kx " + stoch_kx[symbol])
							stoch_d[symbol].unshift(stoch_kx[symbol].reduce((sum, price) => (sum + parseFloat(price)), 0) / d)
							//console.log("d " + stoch_d[symbol])
						}
					}
				}
				//console.log(stoch_kx[symbol][0])
				//console.log(stoch_d[symbol][0])

				// fisher
				fisher_n[symbol] = 0
				fisher[symbol] = 0
				for (let j=ema_period-fisher_period; j>=0; j--) {
					let hl2 = (parseFloat(minute_prices[symbol][j][2])+parseFloat(minute_prices[symbol][j][3]))/2
					let max_hl2 = Math.max.apply(null, minute_prices[symbol].slice(j,j+fisher_period).map(tick => (parseFloat(tick[2])+parseFloat(tick[3]))/2))
					let min_hl2 = Math.min.apply(null, minute_prices[symbol].slice(j,j+fisher_period).map(tick => (parseFloat(tick[2])+parseFloat(tick[3]))/2))
					
					fisher_n[symbol] = 0.33*2*((hl2-min_hl2)/(max_hl2-min_hl2)-0.5)+0.67*fisher_n[symbol]
					let x = fisher_n[symbol]>0.99?0.99999999:fisher_n[symbol]<-0.99?-0.99999999:fisher_n[symbol]
					fisher[symbol] = 0.5*Math.log((1+x)/(1-x))+0.5*fisher[symbol]
				}
				//console.log(fisher[symbol])

				resolve(true)
			}
		}, {limit:ema_period*2+1})
	})
}

async function trackMinutePrices() {
	for (var i = 0, len = pairs.length; i < len; i++) {
		isTrading[pairs[i]] = false
		stopgain[pairs[i]] = 0
		stoploss[pairs[i]] = 0
		signal1[pairs[i]] = false
		//warmup
		await getPrevMinutePrices(pairs[i])
		await sleep(wait_time)
		console.log( (i+1) + " > " + pairs[i] + " " + minute_prices[pairs[i]].length + " unit prices retrieved")
		await trackFutureMinutePrices(pairs[i])
		await sleep(wait_time)
		console.log( (i+1) + " > " + pairs[i] + " future prices tracked.")
	}
}

trackFutureMinutePrices = (pair) => {
	return new Promise(resolve => {
		binance.websockets.candlesticks([pair], "5m", (candlesticks) => {
			let { e:eventType, E:eventTime, s:symbol, k:ticks } = candlesticks
			let { t:time, o:_open, h:_high, l:_low, c:_close, v:volume, n:trades, i:interval, x:isFinal, q:quoteVolume, V:buyVolume, Q:quoteBuyVolume } = ticks
			
			let open = (_open*M).toFixed(0)
			let high = (_high*M).toFixed(0)
			let low = (_low*M).toFixed(0)
			let close = (_close*M).toFixed(0)
			
			let cond = buying(symbol, candlesticks)
			if (cond === "BUY" && !isTrading[pair]) {
				isTrading[pair]=true
				buyingPrice[pair] = bidask[symbol][1][0][0]
				buyingTime[pair] = eventTime
				numBuy++
				if (numBuy > maxBuy) maxBuy = numBuy
				console.log(symbol + " BUY - " + close + "," + bidask[symbol][1][0][0] + " - " + numBuy + "," + maxBuy)
			}	
			
			if (isFinal) {
				let tick = minute_prices[symbol].pop()
				tick[0] = time
				tick[1] = _open
				tick[2] = _high
				tick[3] = _low
				tick[4] = _close
				tick[5] = volume
				tick[6] = 0
				tick[7] = quoteVolume
				tick[8] = trades
				tick[9] = buyVolume
				tick[10] = quoteBuyVolume 
				minute_prices[symbol].unshift(tick)
				ema[symbol] = (minute_prices[symbol][0][4] - ema[symbol])*(2/(ema_period+1))+ema[symbol]
				//console.log(ema[symbol])

				let max_high = Math.max.apply(null, minute_prices[symbol].slice(0,k).map(tick => tick[2]))
				let min_low = Math.min.apply(null, minute_prices[symbol].slice(0,k).map(tick => tick[3]))
				stoch_k[symbol].unshift(((minute_prices[symbol][0][4] - min_low)/(max_high - min_low))*100)
				if (stoch_k[symbol].length >= kx) {
					if (stoch_k[symbol].length > kx) stoch_k[symbol].pop()
					//console.log("k " + stoch_k[symbol])
					stoch_kx[symbol].unshift(stoch_k[symbol].reduce((sum, price) => (sum + parseFloat(price)), 0) / kx)
					if (stoch_kx[symbol].length >= d) {
						if (stoch_kx[symbol].length > d) stoch_kx[symbol].pop()
						stoch_d[symbol].pop()
						//console.log("kx " + stoch_kx[symbol])
						stoch_d[symbol].unshift(stoch_kx[symbol].reduce((sum, price) => (sum + parseFloat(price)), 0) / d)
						//console.log("d " + stoch_d[symbol])
					}
				}

				let hl2 = (parseFloat(minute_prices[symbol][0][2])+parseFloat(minute_prices[symbol][0][3]))/2
				let max_hl2 = Math.max.apply(null, minute_prices[symbol].slice(0,fisher_period).map(tick => (parseFloat(tick[2])+parseFloat(tick[3]))/2))
				let min_hl2 = Math.min.apply(null, minute_prices[symbol].slice(0,fisher_period).map(tick => (parseFloat(tick[2])+parseFloat(tick[3]))/2))
					
				fisher_n[symbol] = 0.33*2*((hl2-min_hl2)/(max_hl2-min_hl2)-0.5)+0.67*fisher_n[symbol]
				let x = fisher_n[symbol]>0.99?0.99999999:fisher_n[symbol]<-0.99?-0.99999999:fisher_n[symbol]
				fisher[symbol] = 0.5*Math.log((1+x)/(1-x))+0.5*fisher[symbol]
				
				//console.log(stoch_kx[symbol][0])
				//console.log(stoch_d[symbol][0])
				//console.log(fisher[symbol])
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
