// StoreKit In-App Purchase shim for SoloPDF (macOS MAS + iOS App Store).
// Compiled with -fobjc-arc via cc::Build in build.rs.
//
// Exposes synchronous C entry points intended to be invoked from a background
// Rust thread (std::thread::spawn / spawn_blocking) so the main thread and run
// loop remain completely unblocked while waiting on StoreKit callbacks.

#import <Foundation/Foundation.h>
#import <StoreKit/StoreKit.h>
#import <TargetConditionals.h>
#include <stdlib.h>
#include <string.h>

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"

static NSString *const kPurchasedDefaultsKey = @"solopdf.iap.purchased_ids";

static char *iap_json_copy(id obj) {
    if (!obj) return strdup("null");
    NSError *err = nil;
    NSData *data = [NSJSONSerialization dataWithJSONObject:obj options:0 error:&err];
    if (!data) return strdup("{\"error\":\"json encode failed\"}");
    char *out = (char *)malloc(data.length + 1);
    memcpy(out, data.bytes, data.length);
    out[data.length] = '\0';
    return out;
}

static char *iap_error_json(NSString *msg) {
    return iap_json_copy(@{ @"error" : (msg ?: @"unknown error") });
}

static NSArray<NSString *> *iap_load_purchased_array(void) {
    NSMutableArray<NSString *> *out = [NSMutableArray array];

    NSUserDefaults *ud = [NSUserDefaults standardUserDefaults];
    NSArray<NSString *> *udArr = [ud stringArrayForKey:kPurchasedDefaultsKey];
    if ([udArr isKindOfClass:[NSArray class]]) {
        for (id item in udArr) {
            if ([item isKindOfClass:[NSString class]] && ![out containsObject:item]) {
                [out addObject:item];
            }
        }
    }

    NSUbiquitousKeyValueStore *kv = [NSUbiquitousKeyValueStore defaultStore];
    if (kv) {
        NSArray *kvArr = [kv arrayForKey:kPurchasedDefaultsKey];
        if ([kvArr isKindOfClass:[NSArray class]]) {
            for (id item in kvArr) {
                if ([item isKindOfClass:[NSString class]] && ![out containsObject:item]) {
                    [out addObject:item];
                }
            }
        }
    }

    return out;
}

static void iap_save_purchased_array(NSArray<NSString *> *ids) {
    NSArray<NSString *> *clean = ids ?: @[];
    NSUserDefaults *ud = [NSUserDefaults standardUserDefaults];
    [ud setObject:clean forKey:kPurchasedDefaultsKey];

    NSUbiquitousKeyValueStore *kv = [NSUbiquitousKeyValueStore defaultStore];
    if (kv) {
        [kv setArray:clean forKey:kPurchasedDefaultsKey];
    }
}

static void iap_record_purchased_ns(NSString *productId) {
    if (!productId || productId.length == 0) return;
    NSMutableArray<NSString *> *ids = [iap_load_purchased_array() mutableCopy];
    if (![ids containsObject:productId]) {
        [ids addObject:productId];
    }
    iap_save_purchased_array(ids);
}

static NSString *iap_format_price(NSDecimalNumber *price, NSLocale *locale) {
    if (!price) return @"";
    NSNumberFormatter *fmt = [[NSNumberFormatter alloc] init];
    fmt.numberStyle = NSNumberFormatterCurrencyStyle;
    if (locale) {
        fmt.locale = locale;
    }
    return [fmt stringFromNumber:price] ?: @"";
}

@interface SoloPDFIAPDelegate : NSObject <SKProductsRequestDelegate, SKPaymentTransactionObserver>
@property (nonatomic, strong) NSMutableDictionary<NSString *, SKProduct *> *productCache;
@property (nonatomic, strong) SKProductsRequest *activeRequest;

@property (nonatomic, strong) dispatch_semaphore_t fetchSem;
@property (nonatomic, strong) id fetchResult;

@property (nonatomic, strong) dispatch_semaphore_t purchaseSem;
@property (nonatomic, strong) id purchaseResult;

@property (nonatomic, strong) dispatch_semaphore_t restoreSem;
@property (nonatomic, strong) id restoreResult;
@end

@implementation SoloPDFIAPDelegate

+ (instancetype)shared {
    static SoloPDFIAPDelegate *inst = nil;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        inst = [[SoloPDFIAPDelegate alloc] init];
    });
    return inst;
}

- (instancetype)init {
    self = [super init];
    if (self) {
        _productCache = [NSMutableDictionary dictionary];
    }
    return self;
}

- (void)ensureObserverRegistered {
    static dispatch_once_t obsToken;
    dispatch_once(&obsToken, ^{
        SKPaymentQueue *queue = [SKPaymentQueue defaultQueue];
        if (queue) {
            [queue addTransactionObserver:self];
        }
    });
}

// MARK: - SKProductsRequestDelegate

- (void)productsRequest:(SKProductsRequest *)request didReceiveResponse:(SKProductsResponse *)response {
    NSMutableArray *list = [NSMutableArray array];
    @synchronized (self) {
        for (SKProduct *prod in response.products) {
            NSString *pid = prod.productIdentifier;
            if (!pid) continue;
            self.productCache[pid] = prod;
            NSString *title = prod.localizedTitle ?: @"";
            NSString *desc = prod.localizedDescription ?: @"";
            NSString *price = iap_format_price(prod.price, prod.priceLocale);
            [list addObject:@{
                @"productId" : pid,
                @"title" : title,
                @"description" : desc,
                @"formattedPrice" : price,
            }];
        }
        self.fetchResult = list;
        self.activeRequest = nil;
        if (self.fetchSem) {
            dispatch_semaphore_signal(self.fetchSem);
        }
    }
}

- (void)request:(SKRequest *)request didFailWithError:(NSError *)error {
    @synchronized (self) {
        self.fetchResult = @{
            @"error" : (error.localizedDescription ?: @"StoreKit product request failed")
        };
        self.activeRequest = nil;
        if (self.fetchSem) {
            dispatch_semaphore_signal(self.fetchSem);
        }
    }
}

// MARK: - SKPaymentTransactionObserver

- (void)paymentQueue:(SKPaymentQueue *)queue updatedTransactions:(NSArray<SKPaymentTransaction *> *)transactions {
    for (SKPaymentTransaction *tx in transactions) {
        NSString *pid = tx.payment.productIdentifier ?: @"";
        switch (tx.transactionState) {
            case SKPaymentTransactionStatePurchased:
            case SKPaymentTransactionStateRestored: {
                if (pid.length > 0) {
                    iap_record_purchased_ns(pid);
                }
                [queue finishTransaction:tx];
                NSString *status = (tx.transactionState == SKPaymentTransactionStateRestored)
                                       ? @"restored"
                                       : @"purchased";
                @synchronized (self) {
                    self.purchaseResult = @{
                        @"status" : status,
                        @"productId" : pid,
                        @"purchasedIds" : iap_load_purchased_array(),
                    };
                    if (self.purchaseSem) {
                        dispatch_semaphore_signal(self.purchaseSem);
                    }
                }
                break;
            }
            case SKPaymentTransactionStateFailed: {
                NSError *err = tx.error;
                NSInteger code = err ? err.code : 0;
                [queue finishTransaction:tx];
                @synchronized (self) {
                    if (code == SKErrorPaymentCancelled) {
                        self.purchaseResult = @{
                            @"status" : @"cancelled",
                            @"productId" : pid,
                            @"purchasedIds" : iap_load_purchased_array(),
                        };
                    } else {
                        self.purchaseResult = @{
                            @"error" : (err.localizedDescription ?: @"Purchase failed")
                        };
                    }
                    if (self.purchaseSem) {
                        dispatch_semaphore_signal(self.purchaseSem);
                    }
                }
                break;
            }
            default:
                // Purchasing / Deferred — keep waiting
                break;
        }
    }
}

- (void)paymentQueueRestoreCompletedTransactionsFinished:(SKPaymentQueue *)queue {
    @synchronized (self) {
        self.restoreResult = @{
            @"purchasedIds" : iap_load_purchased_array(),
        };
        if (self.restoreSem) {
            dispatch_semaphore_signal(self.restoreSem);
        }
    }
}

- (void)paymentQueue:(SKPaymentQueue *)queue restoreCompletedTransactionsFailedWithError:(NSError *)error {
    @synchronized (self) {
        self.restoreResult = @{
            @"error" : (error.localizedDescription ?: @"Restore failed")
        };
        if (self.restoreSem) {
            dispatch_semaphore_signal(self.restoreSem);
        }
    }
}

@end

// ============================================================================
// C ABI Exports
// ============================================================================

char *solopdf_iap_get_purchased_json(void) {
    @autoreleasepool {
        return iap_json_copy(iap_load_purchased_array());
    }
}

void solopdf_iap_record_purchased(const char *product_id) {
    @autoreleasepool {
        if (!product_id) return;
        NSString *pid = [NSString stringWithUTF8String:product_id];
        iap_record_purchased_ns(pid);
    }
}

void solopdf_iap_set_purchased_json(const char *ids_json) {
    @autoreleasepool {
        if (!ids_json) return;
        NSData *data = [NSData dataWithBytes:ids_json length:strlen(ids_json)];
        id obj = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
        if ([obj isKindOfClass:[NSArray class]]) {
            iap_save_purchased_array(obj);
        }
    }
}

int solopdf_iap_is_mas_receipt_present(void) {
    @autoreleasepool {
#if TARGET_OS_IPHONE
        return 1;
#else
        NSBundle *bundle = [NSBundle mainBundle];
        if (!bundle) return 0;
        NSFileManager *fm = [NSFileManager defaultManager];
        NSString *prof = [bundle.bundlePath stringByAppendingPathComponent:@"Contents/embedded.provisionprofile"];
        if (prof && [fm fileExistsAtPath:prof]) {
            return 1;
        }
        NSURL *receiptURL = bundle.appStoreReceiptURL;
        if (receiptURL && receiptURL.path && [fm fileExistsAtPath:receiptURL.path]) {
            return 1;
        }
        return 0;
#endif
    }
}

char *solopdf_iap_fetch_products_sync(const char *ids_json) {
    @autoreleasepool {
        if (!ids_json) return iap_error_json(@"missing product ids");
        NSData *data = [NSData dataWithBytes:ids_json length:strlen(ids_json)];
        id parsed = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
        if (![parsed isKindOfClass:[NSArray class]]) {
            return iap_error_json(@"invalid product ids json");
        }
        NSMutableSet<NSString *> *pidSet = [NSMutableSet set];
        for (id item in (NSArray *)parsed) {
            if ([item isKindOfClass:[NSString class]] && ((NSString *)item).length > 0) {
                [pidSet addObject:item];
            }
        }
        if (pidSet.count == 0) {
            return iap_json_copy(@[]);
        }

        SoloPDFIAPDelegate *del = [SoloPDFIAPDelegate shared];
        dispatch_semaphore_t sem = dispatch_semaphore_create(0);
        @synchronized (del) {
            if (del.activeRequest) {
                [del.activeRequest cancel];
                del.activeRequest = nil;
            }
            del.fetchSem = sem;
            del.fetchResult = nil;
        }

        dispatch_async(dispatch_get_main_queue(), ^{
            [del ensureObserverRegistered];
            SKProductsRequest *req = [[SKProductsRequest alloc] initWithProductIdentifiers:pidSet];
            req.delegate = del;
            @synchronized (del) {
                del.activeRequest = req;
            }
            [req start];
        });

        long waited = dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 15LL * NSEC_PER_SEC));
        id result = nil;
        @synchronized (del) {
            if (waited != 0) {
                [del.activeRequest cancel];
                del.activeRequest = nil;
                del.fetchSem = nil;
                return iap_error_json(@"StoreKit request timed out");
            }
            result = del.fetchResult;
            del.fetchSem = nil;
            del.fetchResult = nil;
        }
        return iap_json_copy(result ?: @[]);
    }
}

char *solopdf_iap_purchase_sync(const char *product_id_utf8) {
    @autoreleasepool {
        if (!product_id_utf8 || !*product_id_utf8) {
            return iap_error_json(@"missing product id");
        }
        NSString *pid = [NSString stringWithUTF8String:product_id_utf8];
        if (![SKPaymentQueue canMakePayments]) {
            return iap_error_json(@"In-App Purchases are disabled on this device.");
        }

        SoloPDFIAPDelegate *del = [SoloPDFIAPDelegate shared];
        SKProduct *prod = nil;
        @synchronized (del) {
            prod = del.productCache[pid];
        }
        if (!prod) {
            char *reqJson = iap_json_copy(@[ pid ]);
            char *fetchOut = solopdf_iap_fetch_products_sync(reqJson);
            free(reqJson);
            if (fetchOut) free(fetchOut);
            @synchronized (del) {
                prod = del.productCache[pid];
            }
        }
        if (!prod) {
            NSString *msg = [NSString stringWithFormat:@"Product '%@' is not yet available in App Store Connect.", pid];
            return iap_error_json(msg);
        }

        dispatch_semaphore_t sem = dispatch_semaphore_create(0);
        @synchronized (del) {
            del.purchaseSem = sem;
            del.purchaseResult = nil;
        }

        dispatch_async(dispatch_get_main_queue(), ^{
            [del ensureObserverRegistered];
            SKPayment *payment = [SKPayment paymentWithProduct:prod];
            [[SKPaymentQueue defaultQueue] addPayment:payment];
        });

        long waited = dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 120LL * NSEC_PER_SEC));
        id result = nil;
        @synchronized (del) {
            if (waited != 0) {
                del.purchaseSem = nil;
                return iap_error_json(@"Purchase timed out");
            }
            result = del.purchaseResult;
            del.purchaseSem = nil;
            del.purchaseResult = nil;
        }
        return iap_json_copy(result ?: @{ @"error" : @"Purchase cancelled" });
    }
}

char *solopdf_iap_restore_sync(void) {
    @autoreleasepool {
        SoloPDFIAPDelegate *del = [SoloPDFIAPDelegate shared];
        dispatch_semaphore_t sem = dispatch_semaphore_create(0);
        @synchronized (del) {
            del.restoreSem = sem;
            del.restoreResult = nil;
        }

        dispatch_async(dispatch_get_main_queue(), ^{
            [del ensureObserverRegistered];
            [[SKPaymentQueue defaultQueue] restoreCompletedTransactions];
        });

        long waited = dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 20LL * NSEC_PER_SEC));
        id result = nil;
        @synchronized (del) {
            if (waited != 0) {
                del.restoreSem = nil;
                return iap_json_copy(@{ @"purchasedIds" : iap_load_purchased_array() });
            }
            result = del.restoreResult;
            del.restoreSem = nil;
            del.restoreResult = nil;
        }
        return iap_json_copy(result ?: @{ @"purchasedIds" : iap_load_purchased_array() });
    }
}

int solopdf_iap_delegate_responds_check(void) {
    @autoreleasepool {
        SoloPDFIAPDelegate *del = [SoloPDFIAPDelegate shared];
        if (!del) return 0;
        BOOL r1 = [del respondsToSelector:@selector(productsRequest:didReceiveResponse:)];
        BOOL r2 = [del respondsToSelector:@selector(request:didFailWithError:)];
        BOOL r3 = [del respondsToSelector:@selector(paymentQueue:updatedTransactions:)];
        BOOL r4 = [del respondsToSelector:@selector(paymentQueueRestoreCompletedTransactionsFinished:)];
        return (r1 && r2 && r3 && r4) ? 1 : 0;
    }
}

void solopdf_iap_free(char *p) {
    if (p) free(p);
}

#pragma clang diagnostic pop
