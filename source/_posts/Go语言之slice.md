---
title: Go语言之slice
date: 2025-09-03 13:46:02
tags: Go
---

## 底层原理

切片（slice）是对数组一个连续片段的引用，所以切片是一个引用类型。切片是一个长度可变的数组。

```go(runtime/slice.go)
type slice struct {
	array unsafe.Pointer
	len   int
	cap   int
}
```

字段说明：

- array：底层数组的地址
- len：切片的长度
- cap：切片的容量

## 切片的创建

```go
func makeslice(et *_type, len, cap int) unsafe.Pointer {
	mem, overflow := math.MulUintptr(et.Size_, uintptr(cap))
	...

	return mallocgc(mem, et, true)
}
```

切片的创建主要就是根据容量去申请一块内存。

## 切片的扩容

扩容是当切片的长度大于容量的时候，底层数组已经装不下时



```go
func growslice(oldPtr unsafe.Pointer, newLen, oldCap, num int, et *_type) slice {
    // newLen：新切片的长度
    // num：添加的元素数
    // oldLen：旧切片（原来的切片的长度）
	oldLen := newLen - num
    // ...
    // 新的长度小于0直接报panic
	if newLen < 0 {
		panic(errorString("growslice: len out of range"))
	}

	if et.Size_ == 0 {
		return slice{unsafe.Pointer(&zerobase), newLen, newLen}
	}

    // 计算新切片的容量
	newcap := nextslicecap(newLen, oldCap)
    ...

	var p unsafe.Pointer
	if !et.Pointers() {
		p = mallocgc(capmem, nil, false)
		memclrNoHeapPointers(add(p, newlenmem), capmem-newlenmem)
	} else {
		p = mallocgc(capmem, et, true)
		if lenmem > 0 && writeBarrier.enabled {
			bulkBarrierPreWriteSrcOnly(uintptr(p), uintptr(oldPtr), lenmem-et.Size_+et.PtrBytes, et)
		}
	}
    // 移动
	memmove(p, oldPtr, lenmem)

	return slice{p, newLen, newcap}
}
```

计算新切片的容量函数：

```go
func nextslicecap(newLen, oldCap int) int {
	newcap := oldCap
	doublecap := newcap + newcap
	if newLen > doublecap {
        // 旧容量的2倍还小于新长度，直接返回新长度
		return newLen
	}

    // 旧容量的2倍大于新长度
	const threshold = 256
	if oldCap < threshold {
        // 小于256的直接返回旧容量的2倍
		return doublecap
	}
	for {
        // 新容量=新容量 + 新容量/4 + 192 
        // 右移2位就是除以4
		newcap += (newcap + 3*threshold) >> 2

        // 直到新的容量大于等于新的长度才推出循环
		if uint(newcap) >= uint(newLen) {
			break
		}
	}

	if newcap <= 0 {
		return newLen
	}
	return newcap
}
```