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
  return liquidationSide === 'BUY' ? 'Most probably DOWN-trend' : 'Most probably UP-trend';
}

export function getBotTradeSide(liquidationSide) {
  if (config.current.tradeDirection === 'trend') {
    return getOppositeTradeSide(liquidationSide);
  } else if (config.current.tradeDirection === 'rebound') {
    return liquidationSide;
  }
}

export default {
  roundDownToTwoDecimals,
  calculateBidAmount,
  getOppositeTradeSide,
  translatePositionSide,
  getTokenTrend,
  getBotTradeSide
};