// helpers.js
import config from '../utils/configuration.js';

export function roundDownToTwoDecimals(number) {
  return Math.floor(number * 100) / 100;
}

export function calculateBidAmount(exchange) {
  const rawValue = exchange.accountInfo.walletBalance * config.current.bidPercentage / 100;
  return roundDownToTwoDecimals(rawValue);
}

export function getOppositeTradeSide(tradeSide) {
  return tradeSide === 'BUY' ? 'SELL' : 'BUY';
}

export function translatePositionSide(tradeSide) {
  return tradeSide === 'BUY' ? 'LONG' : 'SHORT';
}

export function getTokenTrend(liquidationSide) {
  return liquidationSide === 'BUY' ? 'Most likely UP-trend' : 'Most likely DOWN-trend';
}

export function getBotTradeSide(liquidationSide) {
  if (config.current.tradeDirection === 'trend') {
    return liquidationSide;
  } else if (config.current.tradeDirection === 'rebound') {
    return getOppositeTradeSide(liquidationSide);
  }
}

export function getPercentChange(start, end) {
  if (!start || !end || start === 0) return 0;
  return ((end - start) / start) * 100;
}

export function getCurrentTimestamp() {
  return Math.floor(Date.now() / 1000);
}

export default {
  roundDownToTwoDecimals,
  calculateBidAmount,
  getOppositeTradeSide,
  translatePositionSide,
  getTokenTrend,
  getBotTradeSide,
  getPercentChange,
  getCurrentTimestamp
};